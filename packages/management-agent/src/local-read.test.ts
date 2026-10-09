import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  mkdtemp,
  rename,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readResultSchema,
  type ReadRequest,
  type ReadSelection,
} from "@gh-symphony/management-protocol";
import { AgentRegistry } from "./registry.js";
import { LocalReadAdapter } from "./local-read.js";

let directory: string;
let root: string;
let registry: AgentRegistry;
let adapter: LocalReadAdapter;
let id: string;
const runId = "run-1";
const timestamp = "2026-10-09T00:00:00Z";
function request(selection: ReadSelection): ReadRequest {
  return {
    readId: randomUUID(),
    projectId: randomUUID(),
    sessionId: randomUUID(),
    localProjectId: id,
    submittedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    selection,
  };
}
function log(
  cursor?: string,
  maxBytes = 256 * 1024
): Extract<ReadSelection, { kind: "log-chunk" }> {
  return {
    kind: "log-chunk",
    runId,
    stream: "worker",
    maxBytes,
    ...(cursor ? { cursor } : {}),
  };
}
async function chunk(selection = log()) {
  const result = readResultSchema.parse(await adapter.read(request(selection)));
  if (result.state !== "completed" || result.payload.kind !== "log-chunk")
    throw new Error(JSON.stringify(result));
  return result.payload;
}
async function record(name: string, updatedAt = timestamp) {
  await mkdir(join(root, "runs", name), { recursive: true });
  await writeFile(
    join(root, "runs", name, "run.json"),
    JSON.stringify({
      projectId: "runtime-project",
      runId: name,
      status: "succeeded",
      createdAt: timestamp,
      updatedAt,
      prompt: "secret-prompt",
      error: "secret-error",
      credentials: "secret-credential",
      issue: { title: "secret-title" },
    })
  );
}
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "bounded-read-")));
  const project = join(directory, "project");
  await mkdir(project);
  registry = await AgentRegistry.open(join(directory, "agent"));
  id = (await registry.add(project)).localProjectId;
  root = join(directory, "runtime");
  await record(runId);
  adapter = new LocalReadAdapter(registry, async () => ({
    projectDirectory: root,
    runtimeProjectId: "runtime-project",
  }));
});
afterEach(async () => {
  await registry.close();
  await rm(directory, { recursive: true, force: true });
});

describe("bounded local read protocol with real filesystem records", () => {
  it("projects history/detail, orders a bounded window and excludes secret-bearing fields", async () => {
    await record("run-2", "2026-10-09T01:00:00Z");
    const result = await adapter.read(request({ kind: "runs", limit: 1 }));
    expect(result.state).toBe("completed");
    if (result.state === "completed" && result.payload.kind === "runs")
      expect(result.payload.runs.map((r) => r.runId)).toEqual(["run-2"]);
    const detail = await adapter.read(request({ kind: "run-detail", runId }));
    expect(detail.state).toBe("completed");
    expect(JSON.stringify(detail)).not.toContain("secret");
    if (detail.state === "completed" && detail.payload.kind === "run-detail")
      expect(Object.keys(detail.payload.detail!)).toEqual([
        "runId",
        "status",
        "startedAt",
        "updatedAt",
      ]);
  });
  it("caps wire text at 256 KiB and advances byte cursors through append and EOF", async () => {
    await writeFile(
      join(root, "runs", runId, "worker.log"),
      "a".repeat(256 * 1024 + 5)
    );
    const first = await chunk();
    expect(Buffer.byteLength(first.text)).toBe(256 * 1024);
    expect(first.eof).toBe(false);
    const second = await chunk(log(first.cursor));
    expect(second.text).toBe("aaaaa");
    expect(second.eof).toBe(true);
    await appendFile(join(root, "runs", runId, "worker.log"), "more");
    expect((await chunk(log(second.cursor))).text).toBe("more");
    expect(
      (await adapter.read(request(log(undefined, 256 * 1024 + 1)))).state
    ).toBe("unavailable");
  });
  it("returns explicit reset for replacement, truncation and overwrite/regrowth", async () => {
    const file = join(root, "runs", runId, "worker.log");
    await writeFile(file, "original");
    const original = await chunk();
    await rename(file, file + ".old");
    await writeFile(file, "replacement");
    const replacement = await chunk(log(original.cursor));
    expect(replacement.reset).toBe(true);
    expect(replacement.text).toBe("replacement");
    await writeFile(file, "x");
    const truncated = await chunk(log(replacement.cursor));
    expect(truncated.reset).toBe(true);
    expect(truncated.text).toBe("x");
    await writeFile(file, "different-longer");
    const overwritten = await chunk(log(truncated.cursor));
    expect(overwritten.reset).toBe(true);
    expect(overwritten.text).toBe("different-longer");
  });
  it("preserves UTF-8 boundaries and bounds invalid-byte replacement", async () => {
    const file = join(root, "runs", runId, "worker.log");
    await writeFile(file, "ab😀z");
    const first = await chunk(log(undefined, 4));
    expect(first.text).toBe("ab");
    const second = await chunk(log(first.cursor, 4));
    expect(second.text).toBe("😀");
    expect((await chunk(log(second.cursor, 4))).text).toBe("z");
    await writeFile(file, Buffer.from([255, 255, 255]));
    const invalid = await chunk(log(undefined, 4));
    expect(Buffer.byteLength(invalid.text)).toBeLessThanOrEqual(4);
    expect(invalid.text).toBe("�");
  });
  it("rejects traversal, unknown streams, foreign runs and symlinked files/directories", async () => {
    const file = join(root, "runs", runId, "worker.log");
    await writeFile(join(directory, "outside"), "secret-outside");
    await symlink(join(directory, "outside"), file);
    expect((await adapter.read(request(log()))).state).toBe("unavailable");
    for (const bad of ["../outside", "/outside", "..", "run/../outside"])
      expect(
        (await adapter.read(request({ kind: "run-detail", runId: bad }))).state
      ).toBe("unavailable");
    expect(
      (
        await adapter.read(
          request({
            ...log(),
            stream: "../outside",
          } as unknown as ReadSelection)
        )
      ).state
    ).toBe("unavailable");
    await writeFile(
      join(root, "runs", runId, "run.json"),
      JSON.stringify({
        projectId: "foreign",
        runId,
        status: "succeeded",
        createdAt: timestamp,
        updatedAt: timestamp,
      })
    );
    expect(
      (await adapter.read(request({ kind: "run-detail", runId }))).state
    ).toBe("unavailable");
    await rename(join(root, "runs"), join(root, "saved-runs"));
    await symlink(join(root, "saved-runs"), join(root, "runs"));
    expect(
      (await adapter.read(request({ kind: "runs", limit: 10 }))).state
    ).toBe("unavailable");
  });
  it("reports missing/expired/unmanaged reads and rejects malformed or cross-stream cursors", async () => {
    expect((await adapter.read(request(log()))).state).toBe("unavailable");
    await writeFile(join(root, "runs", runId, "worker.log"), "worker");
    await writeFile(join(root, "runs", runId, "events.ndjson"), "events");
    await writeFile(join(root, "orchestrator.log"), "orchestrator");
    const first = await chunk();
    expect((await chunk({ ...log(), stream: "events" })).text).toBe("events");
    expect((await chunk({ ...log(), stream: "orchestrator" })).text).toBe(
      "orchestrator"
    );
    expect(
      (await adapter.read(request({ ...log(first.cursor), stream: "events" })))
        .state
    ).toBe("unavailable");
    expect((await adapter.read(request(log("tampered")))).state).toBe(
      "unavailable"
    );
    const expired = request(log());
    expired.submittedAt = "2026-01-01T00:00:00Z";
    expired.expiresAt = "2026-01-01T00:00:01Z";
    expect((await adapter.read(expired)).state).toBe("expired");
    await registry.remove(id);
    expect((await adapter.read(request(log()))).state).toBe("unavailable");
  });
});
