import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const tempRoots: string[] = [];

  afterEach(() => {
    delete process.env.GITHUB_GRAPHQL_TOKEN;
    delete process.env.GITHUB_TOKEN;
  });

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) =>
        rm(root, {
          force: true,
          recursive: true,
        })
      )
    );
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

  it("throws NotImplementedError on onEvent() until #9 lands", () => {
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

  it("prepares strict MCP config argv and removes the ephemeral file on shutdown", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "claude-adapter-"));
    const runtimeRoot = join(workspaceRoot, "runtime");
    tempRoots.push(workspaceRoot);
    const calls: Array<{
      args: ReadonlyArray<string>;
    }> = [];
    const { child, stdout, stderr } = createStubChild();

    const spawnImpl: SpawnLike = (_command, args) => {
      calls.push({ args });

      queueMicrotask(() => {
        stdout.end();
        stderr.end();
        child.emit("close", 0, null);
      });

      return child;
    };

    const adapter = new ClaudePrintRuntimeAdapter(
      {
        workingDirectory: workspaceRoot,
        runtimeDirectory: runtimeRoot,
        env: {
          GITHUB_GRAPHQL_TOKEN: "runtime-token",
        },
        isolation: {
          strictMcpConfig: true,
        },
      },
      { spawnImpl }
    );

    await adapter.prepare({ runId: "run-1" });
    await adapter.spawnTurn({
      messages: [],
    });

    const mcpConfigPath = join(runtimeRoot, "mcp.json");
    expect(calls[0]?.args).toContain("--strict-mcp-config");
    expect(calls[0]?.args).toContain("--mcp-config");
    expect(calls[0]?.args).toContain(mcpConfigPath);
    expect(await readFile(mcpConfigPath, "utf8")).toContain("github_graphql");

    await adapter.shutdown();

    await expect(readFile(mcpConfigPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not inherit host MCP credentials during prepare unless enabled", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "host-token";
    const workspaceRoot = await mkdtemp(join(tmpdir(), "claude-adapter-"));
    tempRoots.push(workspaceRoot);

    const adapter = new ClaudePrintRuntimeAdapter({
      workingDirectory: workspaceRoot,
      env: {
        GITHUB_PROJECT_ID: "project-from-config",
      },
    });

    await adapter.prepare({ runId: "run-1" });

    const config = JSON.parse(
      await readFile(join(workspaceRoot, ".mcp.json"), "utf8")
    ) as {
      mcpServers?: {
        github_graphql?: {
          env?: Record<string, string>;
        };
      };
    };

    expect(config.mcpServers?.github_graphql?.env).toMatchObject({
      GITHUB_PROJECT_ID: "project-from-config",
    });
    expect(
      config.mcpServers?.github_graphql?.env?.GITHUB_GRAPHQL_TOKEN
    ).toBeUndefined();
  });

  it("can opt in to inheriting host MCP credentials during prepare", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "host-token";
    const workspaceRoot = await mkdtemp(join(tmpdir(), "claude-adapter-"));
    tempRoots.push(workspaceRoot);

    const adapter = new ClaudePrintRuntimeAdapter({
      workingDirectory: workspaceRoot,
      inheritProcessEnv: true,
    });

    await adapter.prepare({ runId: "run-1" });

    expect(await readFile(join(workspaceRoot, ".mcp.json"), "utf8")).toContain(
      "host-token"
    );
  });

  it("rejects strict MCP config spawns without prepare or explicit config path", async () => {
    const adapter = new ClaudePrintRuntimeAdapter({
      workingDirectory: "/workspace",
      isolation: {
        strictMcpConfig: true,
      },
    });

    await expect(
      adapter.spawnTurn({
        messages: [],
      })
    ).rejects.toThrowError("requires prepare()");
  });

  it("removes strict MCP ephemeral config on cancel", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "claude-adapter-"));
    const runtimeRoot = join(workspaceRoot, "runtime");
    tempRoots.push(workspaceRoot);

    const adapter = new ClaudePrintRuntimeAdapter({
      workingDirectory: workspaceRoot,
      runtimeDirectory: runtimeRoot,
      isolation: {
        strictMcpConfig: true,
      },
    });

    await adapter.prepare({ runId: "run-1" });
    const mcpConfigPath = join(runtimeRoot, "mcp.json");
    expect(await readFile(mcpConfigPath, "utf8")).toContain("github_graphql");

    await adapter.cancel("test");

    await expect(readFile(mcpConfigPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("replaces strict MCP ephemeral config when prepare is called again", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "claude-adapter-"));
    const runtimeRoot = join(workspaceRoot, "runtime");
    tempRoots.push(workspaceRoot);
    const env = {
      GITHUB_GRAPHQL_TOKEN: "first-token",
    };

    const adapter = new ClaudePrintRuntimeAdapter({
      workingDirectory: workspaceRoot,
      runtimeDirectory: runtimeRoot,
      env,
      isolation: {
        strictMcpConfig: true,
      },
    });

    await adapter.prepare({ runId: "run-1" });
    const mcpConfigPath = join(runtimeRoot, "mcp.json");
    expect(await readFile(mcpConfigPath, "utf8")).toContain("first-token");

    env.GITHUB_GRAPHQL_TOKEN = "second-token";
    await adapter.prepare({ runId: "run-2" });
    const replacedConfig = await readFile(mcpConfigPath, "utf8");
    expect(replacedConfig).toContain("second-token");
    expect(replacedConfig).not.toContain("first-token");

    await adapter.shutdown();
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

    await adapter.cancel("test");
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
