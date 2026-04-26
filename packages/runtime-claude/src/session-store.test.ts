import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLAUDE_SESSION_PROTOCOL,
  ClaudeSessionStore,
  parseClaudeSessionFile,
} from "./session-store.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "claude-session-store-"));
  tempDirs.push(dir);
  return dir;
}

describe("ClaudeSessionStore", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, {
      recursive: true,
      force: true,
    })));
  });

  it("saves claude-print session files with protocol discriminator", async () => {
    const runtimeRoot = await createTempDir();
    const store = new ClaudeSessionStore({ runtimeRoot });

    await store.save({
      runId: "run-1",
      sessionId: "session-1",
      createdAt: "2026-04-26T00:00:00.000Z",
      parentRunId: "run-prev",
    });

    const raw = await readFile(
      join(runtimeRoot, "runs", "run-1", "claude-session.json"),
      "utf8"
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.protocol).toBe(CLAUDE_SESSION_PROTOCOL);
    expect(parsed.sessionId).toBe("session-1");
    expect(parsed.parentRunId).toBe("run-prev");
    expect(parsed.protocolState).toEqual({});
  });

  it("loads null for missing session files and rejects other protocols", async () => {
    const runtimeRoot = await createTempDir();
    const store = new ClaudeSessionStore({ runtimeRoot });

    await expect(store.load({ runId: "missing" })).resolves.toBeNull();

    const runDir = join(runtimeRoot, "runs", "run-1");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "claude-session.json"),
      JSON.stringify({
        protocol: "acp",
        sessionId: "session-1",
        createdAt: "2026-04-26T00:00:00.000Z",
      })
    );

    await expect(store.load({ runId: "run-1" })).rejects.toThrowError(
      "protocol"
    );
  });

  it("normalizes absent protocolState to an empty object", () => {
    expect(
      parseClaudeSessionFile({
        protocol: "claude-print",
        sessionId: "session-1",
        createdAt: "2026-04-26T00:00:00.000Z",
      }).protocolState
    ).toEqual({});
  });
});
