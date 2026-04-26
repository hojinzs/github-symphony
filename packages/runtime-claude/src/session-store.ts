import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const CLAUDE_SESSION_PROTOCOL = "claude-print" as const;
export const CLAUDE_SESSION_FILENAME = "claude-session.json";

export type ClaudeSessionProtocol = typeof CLAUDE_SESSION_PROTOCOL;

export type ClaudeSessionFile = {
  protocol: ClaudeSessionProtocol;
  sessionId: string;
  createdAt: string;
  parentRunId?: string;
  protocolState: Record<string, unknown>;
};

export type ClaudeSessionStoreOptions = {
  runtimeRoot: string;
};

export type SaveClaudeSessionOptions = {
  runId: string;
  sessionId: string;
  createdAt: string;
  parentRunId?: string;
  protocolState?: Record<string, unknown>;
  runDirectory?: string;
};

export type LoadClaudeSessionOptions = {
  runId: string;
  runDirectory?: string;
};

export class ClaudeSessionStore {
  constructor(private readonly options: ClaudeSessionStoreOptions) {}

  sessionFilePath(options: LoadClaudeSessionOptions): string {
    return join(
      options.runDirectory ?? this.runDirectory(options.runId),
      CLAUDE_SESSION_FILENAME
    );
  }

  async load(
    options: LoadClaudeSessionOptions
  ): Promise<ClaudeSessionFile | null> {
    let raw: string;
    try {
      raw = await readFile(this.sessionFilePath(options), "utf8");
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return null;
      }
      throw error;
    }

    return parseClaudeSessionFile(JSON.parse(raw));
  }

  async save(options: SaveClaudeSessionOptions): Promise<ClaudeSessionFile> {
    const session: ClaudeSessionFile = {
      protocol: CLAUDE_SESSION_PROTOCOL,
      sessionId: options.sessionId,
      createdAt: options.createdAt,
      protocolState: options.protocolState ?? {},
    };

    if (options.parentRunId) {
      session.parentRunId = options.parentRunId;
    }

    const path = this.sessionFilePath(options);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(`${path}.tmp`, `${JSON.stringify(session, null, 2)}\n`, "utf8");
    await rename(`${path}.tmp`, path);
    return session;
  }

  runDirectory(runId: string): string {
    return join(this.options.runtimeRoot, "runs", runId);
  }
}

export function parseClaudeSessionFile(value: unknown): ClaudeSessionFile {
  if (!isRecord(value)) {
    throw new Error("Claude session file must be a JSON object.");
  }
  if (value.protocol !== CLAUDE_SESSION_PROTOCOL) {
    throw new Error("Claude session file protocol must be claude-print.");
  }
  if (typeof value.sessionId !== "string" || value.sessionId.length === 0) {
    throw new Error("Claude session file sessionId must be a non-empty string.");
  }
  if (typeof value.createdAt !== "string" || value.createdAt.length === 0) {
    throw new Error("Claude session file createdAt must be a non-empty string.");
  }
  if (
    "parentRunId" in value &&
    value.parentRunId !== undefined &&
    typeof value.parentRunId !== "string"
  ) {
    throw new Error("Claude session file parentRunId must be a string.");
  }
  if (
    "protocolState" in value &&
    value.protocolState !== undefined &&
    !isRecord(value.protocolState)
  ) {
    throw new Error("Claude session file protocolState must be an object.");
  }

  return {
    protocol: CLAUDE_SESSION_PROTOCOL,
    sessionId: value.sessionId,
    createdAt: value.createdAt,
    parentRunId: typeof value.parentRunId === "string" ? value.parentRunId : undefined,
    protocolState: isRecord(value.protocolState) ? value.protocolState : {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFileNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
