import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeRuntimeNotImplementedError,
  ClaudePrintRuntimeAdapter,
  createClaudePrintRuntimeAdapter,
  resolveClaudeCredentials,
} from "./adapter.js";
import type { SpawnLike } from "./spawn.js";

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
  afterEach(() => {
    delete process.env.GITHUB_TOKEN;
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

  it("does not subscribe to events before #9 lands", () => {
    const adapter = new ClaudePrintRuntimeAdapter({
      workingDirectory: "/workspace",
    });

    expect(() => adapter.onEvent(() => {})).toThrowError(
      ClaudeRuntimeNotImplementedError
    );
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
