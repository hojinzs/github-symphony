import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
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
  });

  it("returns an event subscription cleanup function", () => {
    const adapter = new ClaudePrintRuntimeAdapter({
      workingDirectory: "/workspace",
    });

    const unsubscribe = adapter.onEvent(() => {});

    expect(unsubscribe).toBeTypeOf("function");
  });

  it("exposes a factory helper", () => {
    const adapter = createClaudePrintRuntimeAdapter({
      workingDirectory: "/workspace",
    });

    expect(adapter).toBeInstanceOf(ClaudePrintRuntimeAdapter);
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
