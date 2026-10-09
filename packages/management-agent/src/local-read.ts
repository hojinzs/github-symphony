import { createHash, createHmac, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  opendir,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  LIMITS,
  readRequestSchema,
  runSummarySchema,
  type ReadPayload,
  type ReadRequest,
  type ReadResult,
  type RunSummary,
} from "@gh-symphony/management-protocol";
import type { AgentRegistry, RegisteredProject } from "./registry.js";

/** The CLI resolves ownership using its existing canonical-runtime records.
 * This is a local trusted dependency, never a path supplied over the protocol. */
export interface LocalReadRuntime {
  projectDirectory: string;
  runtimeProjectId: string;
}
export type LocalReadRuntimeResolver = (
  project: RegisteredProject
) => Promise<LocalReadRuntime | null>;

interface Cursor {
  scope: string;
  generation: string;
  offset: number;
  anchor: string;
}
const STREAM_FILES = {
  worker: "worker.log",
  events: "events.ndjson",
  orchestrator: "orchestrator.log",
} as const;

/** On-demand reads only: no lifecycle slot, process effects or persistent logs. */
export class LocalReadAdapter {
  private readonly cursorKey = randomBytes(32);
  constructor(
    private readonly registry: AgentRegistry,
    private readonly resolveRuntime: LocalReadRuntimeResolver
  ) {}

  async read(input: ReadRequest): Promise<ReadResult> {
    const unavailable = (
      code: "invalid_input" | "project_unmanaged" | "log_unavailable"
    ) => ({
      readId: input.readId,
      state: "unavailable" as const,
      diagnostic: {
        code,
        message:
          "Requested local data unavailable; inspect the project locally",
      },
    });
    let request: ReadRequest;
    try {
      request = readRequestSchema.parse(input);
    } catch {
      return unavailable("invalid_input");
    }
    if (Date.parse(request.expiresAt) <= Date.now()) {
      return {
        readId: request.readId,
        state: "expired",
        diagnostic: { code: "command_expired", message: "Local read expired" },
      };
    }
    let project: RegisteredProject;
    try {
      project = await this.registry.resolveManaged(request.localProjectId);
    } catch {
      return unavailable("project_unmanaged");
    }
    try {
      const runtime = await this.resolveRuntime(project);
      if (!runtime) return unavailable("log_unavailable");
      const root = resolve(runtime.projectDirectory);
      if ((await realpath(root)) !== root || !(await lstat(root)).isDirectory())
        throw new Error("Invalid runtime root");
      const selection = request.selection;
      let payload: ReadPayload;
      if (selection.kind === "runs") {
        // The server retains at most 100 summaries; this adapter returns the same
        // bounded recent window, without unbounded pagination or raw snapshots.
        if (selection.cursor) throw new Error("Unsupported history cursor");
        const runs: RunSummary[] = [];
        let unavailableRecords = 0;
        const directory = await this.directory(root, join(root, "runs"));
        for await (const entry of await opendir(directory)) {
          if (!entry.isDirectory() || !validRunId(entry.name)) continue;
          try {
            runs.push(
              await this.summary(root, runtime.runtimeProjectId, entry.name)
            );
            runs.sort(
              (a, b) =>
                b.updatedAt.localeCompare(a.updatedAt) ||
                a.runId.localeCompare(b.runId)
            );
            if (runs.length > selection.limit) runs.pop();
          } catch {
            // Corrupt or foreign records cannot become uploadable metadata.
            unavailableRecords++;
          }
        }
        if (runs.length === 0 && unavailableRecords > 0)
          throw new Error("History unavailable");
        payload = { kind: "runs", runs };
      } else {
        if (!validRunId(selection.runId)) throw new Error("Invalid run ID");
        const summary = await this.summary(
          root,
          runtime.runtimeProjectId,
          selection.runId
        );
        if (selection.kind === "run-detail") {
          payload = {
            kind: "run-detail",
            runId: selection.runId,
            detail: { ...summary },
          };
        } else {
          const file =
            selection.stream === "orchestrator"
              ? join(root, STREAM_FILES.orchestrator)
              : join(
                  root,
                  "runs",
                  selection.runId,
                  STREAM_FILES[selection.stream]
                );
          const handle = await this.file(root, file);
          try {
            const metadata = await handle.stat();
            const generation = digest(
              `${metadata.dev}:${metadata.ino}:${metadata.birthtimeMs}`
            );
            const scope = digest(
              `${request.localProjectId}:${selection.runId}:${selection.stream}`
            );
            const cursor = selection.cursor
              ? this.decode(selection.cursor)
              : null;
            if (cursor && cursor.scope !== scope)
              throw new Error("Foreign cursor");
            const reset =
              cursor !== null &&
              (cursor.generation !== generation ||
                cursor.offset > metadata.size ||
                cursor.anchor !== (await anchor(handle, cursor.offset)));
            const offset = cursor && !reset ? cursor.offset : 0;
            const buffer = Buffer.alloc(
              Math.min(selection.maxBytes, LIMITS.logChunkBytes)
            );
            const { bytesRead } = await handle.read(
              buffer,
              0,
              buffer.length,
              offset
            );
            // Streaming decoder retains an incomplete UTF-8 suffix for the next
            // chunk. Invalid bytes are replaced, with wire bytes still bounded.
            let consumed = 0;
            let text = "";
            let low = 0;
            let high = bytesRead;
            // Binary search avoids quadratic decoding when every byte is invalid.
            while (low <= high) {
              const candidate = Math.floor((low + high) / 2);
              const decoded = new TextDecoder().decode(
                buffer.subarray(0, candidate),
                {
                  stream: offset + candidate < metadata.size,
                }
              );
              if (Buffer.byteLength(decoded) <= selection.maxBytes) {
                consumed = candidate;
                text = decoded;
                low = candidate + 1;
              } else high = candidate - 1;
            }
            // Determine any retained valid suffix, preserving byte offsets.
            if (offset + consumed < metadata.size) {
              let start = consumed - 1;
              while (start >= 0 && (buffer[start]! & 0xc0) === 0x80) start--;
              if (start >= 0) {
                const byte = buffer[start]!;
                const width =
                  byte >= 0xf0 && byte <= 0xf4
                    ? 4
                    : byte >= 0xe0 && byte <= 0xef
                      ? 3
                      : byte >= 0xc2 && byte <= 0xdf
                        ? 2
                        : 1;
                if (consumed - start < width) {
                  consumed = start;
                  // Rollback can also remove malformed bytes already emitted
                  // as replacements; text must match the committed byte offset.
                  text = new TextDecoder().decode(
                    buffer.subarray(0, consumed),
                    {
                      stream: true,
                    }
                  );
                }
              }
            }
            if (bytesRead > 0 && consumed === 0)
              throw new Error("Chunk too small for text");
            const next = offset + consumed;
            await this.directory(root, file, false);
            const current = await lstat(file);
            if (current.ino !== metadata.ino || current.dev !== metadata.dev)
              throw new Error("Read target changed");
            payload = {
              kind: "log-chunk",
              runId: selection.runId,
              stream: selection.stream,
              text,
              reset,
              eof: next >= metadata.size,
              cursor: this.encode({
                scope,
                generation,
                offset: next,
                anchor: await anchor(handle, next),
              }),
            };
          } finally {
            await handle.close();
          }
        }
      }
      await this.registry.resolveManaged(request.localProjectId);
      if (Date.parse(request.expiresAt) <= Date.now())
        return {
          readId: request.readId,
          state: "expired",
          diagnostic: {
            code: "command_expired",
            message: "Local read expired",
          },
        };
      return {
        readId: request.readId,
        state: "completed",
        completedAt: new Date().toISOString(),
        payload,
      };
    } catch {
      // Never upload raw filesystem errors, paths, run errors or credentials.
      return unavailable("log_unavailable");
    }
  }

  private async summary(
    root: string,
    projectId: string,
    runId: string
  ): Promise<RunSummary> {
    const handle = await this.file(root, join(root, "runs", runId, "run.json"));
    try {
      const size = (await handle.stat()).size;
      if (size > LIMITS.logChunkBytes) throw new Error("Oversized record");
      // One extra byte detects concurrent growth without allocating a full
      // 256 KiB chunk for every small history record.
      const buffer = Buffer.alloc(size + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > size) throw new Error("Record changed during read");
      const record = JSON.parse(
        buffer.subarray(0, bytesRead).toString("utf8")
      ) as Record<string, unknown>;
      if (record.projectId !== projectId || record.runId !== runId)
        throw new Error("Foreign run");
      if (
        ![
          "pending",
          "starting",
          "running",
          "retrying",
          "succeeded",
          "failed",
          "suppressed",
        ].includes(String(record.status))
      )
        throw new Error("Invalid status");
      return runSummarySchema.parse({
        runId,
        status: record.status,
        startedAt: record.startedAt ?? record.createdAt,
        updatedAt: record.updatedAt,
      });
    } finally {
      await handle.close();
    }
  }
  private async directory(
    root: string,
    path: string,
    directory = true
  ): Promise<string> {
    const rel = relative(root, path);
    if (!rel || rel.startsWith(`..${sep}`) || rel === "..")
      throw new Error("Escaping path");
    let current = root;
    const parts = rel.split(sep);
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const metadata = await lstat(current);
      if (
        metadata.isSymbolicLink() ||
        ((directory || index < parts.length - 1) && !metadata.isDirectory())
      )
        throw new Error("Invalid path component");
    }
    if ((await realpath(path)) !== path) throw new Error("Changed path");
    return path;
  }
  private async file(root: string, path: string): Promise<FileHandle> {
    await this.directory(root, path, false);
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    );
    try {
      if (!(await handle.stat()).isFile())
        throw new Error("Not a regular file");
      await this.directory(root, path, false);
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  private encode(cursor: Cursor): string {
    const data = Buffer.from(JSON.stringify(cursor)).toString("base64url");
    return `${data}.${createHmac("sha256", this.cursorKey).update(data).digest("base64url")}`;
  }
  private decode(value: string): Cursor {
    if (value.length > 2048) throw new Error("Invalid cursor");
    const [data, signature] = value.split(".");
    if (
      !data ||
      !signature ||
      createHmac("sha256", this.cursorKey).update(data).digest("base64url") !==
        signature
    )
      throw new Error("Invalid cursor");
    const cursor = JSON.parse(
      Buffer.from(data, "base64url").toString("utf8")
    ) as Cursor;
    if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0)
      throw new Error("Invalid offset");
    return cursor;
  }
}
function validRunId(value: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(value);
}
function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
async function anchor(handle: FileHandle, offset: number): Promise<string> {
  const buffer = Buffer.alloc(Math.min(offset, 64));
  const { bytesRead } = await handle.read(
    buffer,
    0,
    buffer.length,
    offset - buffer.length
  );
  return digest(buffer.subarray(0, bytesRead));
}
