import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WORKFLOW_DEFINITION,
  type WorkflowDefinition,
} from "@gh-symphony/core";
import {
  CustomCommandWorkerRuntimeAdapter,
  createWorkerNonCodexRuntimeAdapter,
} from "./non-codex-runtime.js";

describe("CustomCommandWorkerRuntimeAdapter", () => {
  it("spawns a custom command without the Codex JSON-RPC protocol", async () => {
    const fake = createFakeChild();
    const spawnImpl = vi.fn(() => fake.child);
    const adapter = new CustomCommandWorkerRuntimeAdapter(
      {
        workingDirectory: "/repo",
        command: "agent",
        args: ["--run"],
        env: {
          EXISTING_ENV: "1",
        },
      },
      { spawnImpl }
    );

    const resultPromise = adapter.spawnTurn({
      prompt: "implement issue",
      env: {
        TURN_ENV: "2",
      },
    });
    fake.stdout.end("done");
    fake.stderr.end("warn");
    fake.emitExit(0, null);
    const result = await resultPromise;

    expect(spawnImpl).toHaveBeenCalledWith(
      "agent",
      ["--run"],
      expect.objectContaining({
        cwd: "/repo",
        stdio: "pipe",
        env: expect.objectContaining({
          EXISTING_ENV: "1",
          TURN_ENV: "2",
          SYMPHONY_RENDERED_PROMPT: "implement issue",
        }),
      })
    );
    expect(fake.stdinText()).toBe("implement issue");
    expect(result).toMatchObject({
      command: "agent",
      args: ["--run"],
      stdout: "done",
      stderr: "warn",
      result: "success",
    });
  });
});

describe("createWorkerNonCodexRuntimeAdapter", () => {
  it("creates a claude-print adapter that receives the rendered prompt as a user message", async () => {
    const fake = createFakeChild();
    const spawnImpl = vi.fn(() => fake.child);
    const root = await mkdtemp(join(tmpdir(), "worker-claude-runtime-"));
    const adapter = createWorkerNonCodexRuntimeAdapter(
      workflowWithRuntime("claude-print", "claude", []),
      {
        workingDirectory: root,
        env: {},
        runtimeRoot: join(root, "runtime"),
        claudeDependencies: {
          spawnImpl,
          createSessionId: () => "session-1",
        },
      }
    );

    await adapter.prepare({ runId: "run-1" });
    const resultPromise = adapter.spawnTurn({
      messages: [
        {
          type: "user",
          message: {
            role: "user",
            content: [{ type: "text", text: "rendered prompt" }],
          },
        },
      ],
    });
    fake.stdout.end(
      `${JSON.stringify({ type: "result", subtype: "success", session_id: "session-1" })}\n`
    );
    fake.stderr.end();
    fake.emitExit(0, null);
    const result = await resultPromise;

    expect(spawnImpl).toHaveBeenCalledWith(
      "claude",
      expect.arrayContaining(["-p", "--output-format", "stream-json"]),
      expect.objectContaining({
        cwd: root,
        stdio: "pipe",
      })
    );
    expect(fake.stdinText()).toBe(
      `${JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "rendered prompt" }],
        },
      })}\n`
    );
    expect(result.result).toBe("success");
  });

  it("creates a custom adapter for custom runtime kind", () => {
    const adapter = createWorkerNonCodexRuntimeAdapter(
      workflowWithRuntime("custom", "agent", ["--flag"]),
      {
        workingDirectory: "/repo",
        env: {},
      }
    );

    expect(adapter).toBeInstanceOf(CustomCommandWorkerRuntimeAdapter);
  });
});

function workflowWithRuntime(
  kind: "claude-print" | "custom",
  command: string,
  args: readonly string[]
): WorkflowDefinition {
  return {
    ...DEFAULT_WORKFLOW_DEFINITION,
    runtime: {
      kind,
      command,
      args,
      isolation: {
        bare: false,
        strictMcpConfig: false,
      },
      auth: {
        env: null,
      },
      timeouts: DEFAULT_WORKFLOW_DEFINITION.codex,
    },
  };
}

function createFakeChild(): {
  child: ChildProcess;
  stdinText: () => string;
  emitExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  stdout: PassThrough;
  stderr: PassThrough;
} {
  const emitter = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stdinText = "";
  stdin.setEncoding("utf8");
  stdin.on("data", (chunk: string) => {
    stdinText += chunk;
  });
  stdin.resume();

  const child = {
    pid: 1234,
    stdin,
    stdout,
    stderr,
    killed: false,
    kill: vi.fn(),
    once: emitter.once.bind(emitter),
    on: emitter.on.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    emit: emitter.emit.bind(emitter),
  } as unknown as ChildProcess;

  return {
    child,
    stdout,
    stderr,
    stdinText: () => stdinText,
    emitExit: (code, signal) => {
      emitter.emit("exit", code, signal);
      emitter.emit("close", code, signal);
    },
  };
}
