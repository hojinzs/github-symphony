import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaudePrintRuntimeAdapter,
  createClaudePrintRuntimeAdapter,
  resolveClaudeCredentials,
} from "./adapter.js";
import type { SpawnLike } from "./spawn.js";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "claude-adapter-"));
  tempDirs.push(dir);
  return dir;
}

function createStubChild() {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  return {
    child: {
      stdin,
      stdout,
      stderr,
      emit(event: string, ...args: unknown[]) {
        emitter.emit(event, ...args);
      },
      once(event: string, listener: (...args: unknown[]) => void) {
        emitter.once(event, listener);
        return this;
      },
      on(event: string, listener: (...args: unknown[]) => void) {
        emitter.on(event, listener);
        return this;
      },
      removeListener(event: string, listener: (...args: unknown[]) => void) {
        emitter.removeListener(event, listener);
        return this;
      },
    } as unknown as ReturnType<SpawnLike>,
    stdout,
    stderr,
  };
}

describe("ClaudePrintRuntimeAdapter", () => {
  afterEach(async () => {
    delete process.env.GITHUB_TOKEN;
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, {
      recursive: true,
      force: true,
    })));
  });

  it("spawns claude with default argv and merged env", async () => {
    const calls: Array<{
      command: string;
      args: ReadonlyArray<string>;
      env: NodeJS.ProcessEnv | undefined;
    }> = [];
    const { child, stdout, stderr } = createStubChild();

    const spawnImpl: SpawnLike = (command, args, options) => {
      calls.push({
        command,
        args,
        env: options.env,
      });

      queueMicrotask(() => {
        stdout.write('{"type":"result"}\n');
        stdout.end();
        stderr.end();
        child.emit("close", 0, null);
      });

      return child;
    };

    const adapter = new ClaudePrintRuntimeAdapter(
      {
        workingDirectory: "/workspace",
        command: "claude",
        env: {
          ANTHROPIC_API_KEY: "base-key",
        },
        isolation: {
          bare: true,
        },
      },
      {
        spawnImpl,
      }
    );

    const result = await adapter.spawnTurn({
      messages: [{ type: "user", text: "hello" }],
      session: {
        mode: "start",
        sessionId: "session-1",
      },
      env: {
        CLAUDE_CODE_ENTRYPOINT: "test",
      },
    });

    expect(result.result).toBe("success");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("claude");
    expect(calls[0]?.args).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
      "--session-id",
      "session-1",
      "--bare",
    ]);
    expect(calls[0]?.env?.ANTHROPIC_API_KEY).toBe("base-key");
    expect(calls[0]?.env?.CLAUDE_CODE_ENTRYPOINT).toBe("test");
    expect(calls[0]?.env?.PATH).toBe(process.env.PATH);
    expect(calls[0]?.env?.GITHUB_TOKEN).toBeUndefined();
  });

  it("subscribes to runtime events", () => {
    const adapter = new ClaudePrintRuntimeAdapter({
      workingDirectory: "/workspace",
    });

    const unsubscribe = adapter.onEvent(() => {});
    expect(unsubscribe).toEqual(expect.any(Function));
    unsubscribe();
  });

  it("exposes a factory helper", () => {
    const adapter = createClaudePrintRuntimeAdapter({
      workingDirectory: "/workspace",
    });

    expect(adapter).toBeInstanceOf(ClaudePrintRuntimeAdapter);
  });

  it("can opt in to inheriting the full process environment", async () => {
    process.env.GITHUB_TOKEN = "from-process-env";
    const calls: Array<NodeJS.ProcessEnv | undefined> = [];
    const { child, stdout, stderr } = createStubChild();

    const spawnImpl: SpawnLike = (_command, _args, options) => {
      calls.push(options.env as NodeJS.ProcessEnv | undefined);

      queueMicrotask(() => {
        stdout.end();
        stderr.end();
        child.emit("close", 0, null);
      });

      return child;
    };

    const adapter = new ClaudePrintRuntimeAdapter(
      {
        workingDirectory: "/workspace",
        inheritProcessEnv: true,
      },
      { spawnImpl }
    );

    await adapter.spawnTurn({
      messages: [],
    });

    expect(calls[0]?.GITHUB_TOKEN).toBe("from-process-env");
  });

  it("terminates the in-flight child on cancel", async () => {
    const kill = vi.fn(() => true);
    const { child, stdout, stderr } = createStubChild();
    const childWithKill = child as ReturnType<SpawnLike> & {
      kill: (signal?: NodeJS.Signals) => boolean;
    };
    childWithKill.kill = kill;

    const spawnImpl: SpawnLike = () => childWithKill;

    const adapter = new ClaudePrintRuntimeAdapter(
      {
        workingDirectory: "/workspace",
      },
      {
        spawnImpl,
      }
    );

    const pending = adapter.spawnTurn({
      messages: [],
    });

    adapter.cancel("test");
    stdout.end();
    stderr.end();
    child.emit("close", null, "SIGTERM");
    await pending;

    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("rejects concurrent in-flight turns until scheduler semantics land", async () => {
    const { child, stdout, stderr } = createStubChild();
    const spawnImpl: SpawnLike = () => child;

    const adapter = new ClaudePrintRuntimeAdapter(
      {
        workingDirectory: "/workspace",
      },
      {
        spawnImpl,
      }
    );

    const pending = adapter.spawnTurn({
      messages: [],
    });

    await expect(
      adapter.spawnTurn({
        messages: [],
      })
    ).rejects.toThrowError("TODO(#8)");

    stdout.end();
    stderr.end();
    child.emit("close", null, "SIGTERM");
    await pending;
  });

  it("returns an empty env object instead of inheriting process env by accident", async () => {
    const originalEnv = process.env;
    const calls: Array<NodeJS.ProcessEnv | undefined> = [];
    const { child, stdout, stderr } = createStubChild();

    const spawnImpl: SpawnLike = (_command, _args, options) => {
      calls.push(options.env as NodeJS.ProcessEnv | undefined);

      queueMicrotask(() => {
        stdout.end();
        stderr.end();
        child.emit("close", 0, null);
      });

      return child;
    };

    process.env = {};

    try {
      const adapter = new ClaudePrintRuntimeAdapter(
        {
          workingDirectory: "/workspace",
        },
        { spawnImpl }
      );

      await adapter.spawnTurn({
        messages: [],
      });
    } finally {
      process.env = originalEnv;
    }

    expect(calls[0]).toEqual({});
  });

  it("prepares a first turn with --session-id and persists the session file", async () => {
    const runtimeRoot = await createTempDir();
    const calls: Array<ReadonlyArray<string>> = [];
    const { child, stdout, stderr } = createStubChild();
    const spawnImpl: SpawnLike = (_command, args) => {
      calls.push(args);
      queueMicrotask(() => {
        stdout.write('{"type":"result"}\n');
        stdout.end();
        stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    };
    const adapter = new ClaudePrintRuntimeAdapter(
      {
        workingDirectory: "/workspace",
        runtimeRoot,
      },
      {
        spawnImpl,
        createSessionId: () => "session-first",
        now: () => new Date("2026-04-26T00:00:00.000Z"),
      }
    );

    await adapter.prepare({ runId: "run-1" });
    await adapter.spawnTurn({ messages: [] });

    expect(calls[0]).toContain("--session-id");
    expect(calls[0]).toContain("session-first");
    const session = JSON.parse(
      await readFile(join(runtimeRoot, "runs", "run-1", "claude-session.json"), "utf8")
    ) as Record<string, unknown>;
    expect(session).toMatchObject({
      protocol: "claude-print",
      sessionId: "session-first",
      createdAt: "2026-04-26T00:00:00.000Z",
      protocolState: {},
    });
  });

  it("uses --resume without fork for an intra-run retry", async () => {
    const runtimeRoot = await createTempDir();
    const calls: Array<ReadonlyArray<string>> = [];
    const children = [createStubChild(), createStubChild(), createStubChild()];
    const spawnImpl: SpawnLike = (_command, args) => {
      const stub = children[calls.length]!;
      calls.push(args);
      queueMicrotask(() => {
        stub.stdout.end();
        stub.stderr.end();
        stub.child.emit("close", 0, null);
      });
      return stub.child;
    };
    const adapter = new ClaudePrintRuntimeAdapter(
      {
        workingDirectory: "/workspace",
        runtimeRoot,
      },
      {
        spawnImpl,
        createSessionId: () => "session-1",
        now: () => new Date("2026-04-26T00:00:00.000Z"),
      }
    );

    await adapter.prepare({ runId: "run-1" });
    await adapter.spawnTurn({ messages: [] });
    await adapter.spawnTurn({ messages: [] });

    expect(calls[1]).toEqual(
      expect.arrayContaining(["--resume", "session-1"])
    );
    expect(calls[1]).not.toContain("--fork-session");
  });

  it("uses --resume with --fork-session for inter-run recover and links the parent run", async () => {
    const runtimeRoot = await createTempDir();
    const calls: Array<ReadonlyArray<string>> = [];
    const children = [createStubChild(), createStubChild()];
    const spawnImpl: SpawnLike = (_command, args) => {
      const stub = children[calls.length]!;
      calls.push(args);
      queueMicrotask(() => {
        stub.stdout.write('{"session_id":"session-forked"}\n');
        stub.stdout.end();
        stub.stderr.end();
        stub.child.emit("close", 0, null);
      });
      return stub.child;
    };
    const adapter = new ClaudePrintRuntimeAdapter(
      {
        workingDirectory: "/workspace",
        runtimeRoot,
      },
      {
        spawnImpl,
        createSessionId: () => "unused",
        now: () => new Date("2026-04-26T00:00:00.000Z"),
      }
    );
    await adapter.prepare({ runId: "run-prev" });
    await adapter.spawnTurn({ messages: [] });

    await adapter.prepare({
      runId: "run-next",
      previousRunId: "run-prev",
    });
    await adapter.spawnTurn({ messages: [] });

    expect(calls[1]).toEqual(
      expect.arrayContaining(["--resume", "session-forked", "--fork-session"])
    );
    const session = JSON.parse(
      await readFile(
        join(runtimeRoot, "runs", "run-next", "claude-session.json"),
        "utf8"
      )
    ) as Record<string, unknown>;
    expect(session.parentRunId).toBe("run-prev");
    expect(session.sessionId).toBe("session-forked");
    expect(session.protocol).toBe("claude-print");
  });

  it("falls back to a new session id and emits sessionInvalidated when resume returns 4xx", async () => {
    const runtimeRoot = await createTempDir();
    const calls: Array<ReadonlyArray<string>> = [];
    const emitted: string[] = [];
    const children = [createStubChild(), createStubChild(), createStubChild()];
    const spawnImpl: SpawnLike = (_command, args) => {
      const callIndex = calls.length;
      const stub = children[callIndex]!;
      calls.push(args);
      queueMicrotask(() => {
        if (callIndex === 1) {
          stub.stderr.write("resume failed: 401 Unauthorized\n");
          stub.stdout.end();
          stub.stderr.end();
          stub.child.emit("close", 1, null);
          return;
        }
        stub.stdout.end();
        stub.stderr.end();
        stub.child.emit("close", 0, null);
      });
      return stub.child;
    };
    const sessionIds = ["session-fresh"];
    const adapter = new ClaudePrintRuntimeAdapter(
      {
        workingDirectory: "/workspace",
        runtimeRoot,
      },
      {
        spawnImpl,
        createSessionId: () => sessionIds.shift() ?? "session-new",
        now: () => new Date("2026-04-26T00:00:00.000Z"),
      }
    );
    await adapter.prepare({ runId: "run-1" });
    await adapter.spawnTurn({ messages: [] });
    adapter.onEvent((event) => {
      emitted.push(event.name);
    });

    const result = await adapter.spawnTurn({ messages: [] });

    expect(result.result).toBe("success");
    expect(calls[1]).toEqual(
      expect.arrayContaining(["--resume", "session-fresh"])
    );
    expect(calls[2]).toEqual(
      expect.arrayContaining(["--session-id", "session-new"])
    );
    expect(calls[2]).not.toContain("--fork-session");
    expect(emitted).toEqual(["agent.sessionInvalidated"]);
    const session = JSON.parse(
      await readFile(join(runtimeRoot, "runs", "run-1", "claude-session.json"), "utf8")
    ) as Record<string, unknown>;
    expect(session.sessionId).toBe("session-new");
    expect(session.protocol).toBe("claude-print");
  });

  it("replays a prepare-time sessionInvalidated event to later subscribers", async () => {
    const runtimeRoot = await createTempDir();
    const runDir = join(runtimeRoot, "runs", "run-1");
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "claude-session.json"), "{bad json", "utf8");
    const emitted: string[] = [];
    const adapter = new ClaudePrintRuntimeAdapter(
      {
        workingDirectory: "/workspace",
        runtimeRoot,
      },
      {
        createSessionId: () => "session-recovered",
        now: () => new Date("2026-04-26T00:00:00.000Z"),
      }
    );

    await adapter.prepare({ runId: "run-1" });
    adapter.onEvent((event) => {
      emitted.push(event.name);
    });

    expect(emitted).toEqual(["agent.sessionInvalidated"]);
    const session = JSON.parse(
      await readFile(join(runDir, "claude-session.json"), "utf8")
    ) as Record<string, unknown>;
    expect(session.sessionId).toBe("session-recovered");
    expect(session.protocol).toBe("claude-print");
  });
});

describe("resolveClaudeCredentials", () => {
  it("extracts only the Anthropic runtime credential", () => {
    expect(
      resolveClaudeCredentials({
        env: {
          ANTHROPIC_API_KEY: "sk-anthropic",
          OPENAI_API_KEY: "sk-openai",
        },
        expires_at: "2026-04-22T10:10:00.000Z",
      })
    ).toEqual({
      ANTHROPIC_API_KEY: "sk-anthropic",
    });
  });

  it("fails with a clear ANTHROPIC_API_KEY error when missing", () => {
    expect(() =>
      resolveClaudeCredentials({
        env: {},
      })
    ).toThrowError("ANTHROPIC_API_KEY");
  });
});
