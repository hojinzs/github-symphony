import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { parseWorkflowMarkdown } from "@gh-symphony/core";
import { ClaudePrintRuntimeAdapter } from "@gh-symphony/runtime-claude";
import { CodexRuntimeAdapter } from "@gh-symphony/runtime-codex";
import { describe, expect, it } from "vitest";
import {
  createWorkflowRuntimeAdapter,
  CustomCommandRuntimeAdapter,
} from "./runtime-factory.js";
import type { SpawnLike } from "@gh-symphony/runtime-claude";

function parseWorkflow(frontMatter: string) {
  return parseWorkflowMarkdown(`---
tracker:
  kind: github-project
${frontMatter}
---
Prompt.
`);
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
      emit(event: string, ...args: unknown[]) {
        emitter.emit(event, ...args);
      },
    } as unknown as ReturnType<SpawnLike>,
    stdout,
    stderr,
  };
}

describe("createWorkflowRuntimeAdapter", () => {
  it("falls back to the legacy codex adapter when runtime is absent", () => {
    const workflow = parseWorkflow(`codex:
  command: codex app-server --model gpt-5
`);

    const adapter = createWorkflowRuntimeAdapter(workflow, {
      projectId: "project-1",
      workingDirectory: "/workspace",
    });

    expect(adapter).toBeInstanceOf(CodexRuntimeAdapter);
  });

  it("creates a codex-app-server adapter with runtime command args", async () => {
    const workflow = parseWorkflow(`runtime:
  kind: codex-app-server
  command: codex
  args:
    - app-server
    - --model
    - gpt-5
`);

    const adapter = createWorkflowRuntimeAdapter(workflow, {
      projectId: "project-1",
      workingDirectory: "/workspace",
      codexDependencies: {
        mkdirImpl: async () => undefined,
        writeFileImpl: async () => undefined,
        copyFileImpl: async () => undefined,
      },
    });

    expect(adapter).toBeInstanceOf(CodexRuntimeAdapter);
    const codexAdapter = adapter as CodexRuntimeAdapter;
    await codexAdapter.prepare();

    const plan = codexAdapter.getPreparedPlan();
    expect(plan?.args).toEqual(["-lc", "codex app-server --model gpt-5"]);
  });

  it("creates a claude-print adapter with isolation argv context", async () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const { child, stdout, stderr } = createStubChild();
    const spawnImpl: SpawnLike = (_command, args) => {
      calls.push(args);
      queueMicrotask(() => {
        stdout.end();
        stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    };
    const workflow = parseWorkflow(`runtime:
  kind: claude-print
  command: claude
  args:
    - -p
    - --verbose
  isolation:
    bare: true
    strict_mcp_config: true
  auth:
    env: ANTHROPIC_API_KEY
`);

    const adapter = createWorkflowRuntimeAdapter(workflow, {
      projectId: "project-1",
      workingDirectory: "/workspace",
      mcpConfigPath: "/tmp/ephemeral-mcp.json",
      claudeDependencies: {
        spawnImpl,
      },
    });

    expect(adapter).toBeInstanceOf(ClaudePrintRuntimeAdapter);
    await adapter.spawnTurn({
      messages: [],
    });

    expect(calls[0]).toEqual([
      "-p",
      "--verbose",
      "--bare",
      "--strict-mcp-config",
      "--mcp-config",
      "/tmp/ephemeral-mcp.json",
    ]);
  });

  it("creates a custom adapter that spawns command and args exactly", async () => {
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const { child, stdout, stderr } = createStubChild();
    const spawnImpl: SpawnLike = (command, args) => {
      calls.push({ command, args });
      queueMicrotask(() => {
        stdout.end();
        stderr.end();
        child.emit("close", 0, null);
      });
      return child;
    };
    const workflow = parseWorkflow(`runtime:
  kind: custom
  command: node
  args:
    - worker.js
    - --direct
`);

    const adapter = createWorkflowRuntimeAdapter(workflow, {
      projectId: "project-1",
      workingDirectory: "/workspace",
      claudeDependencies: {
        spawnImpl,
      },
    });

    expect(adapter).toBeInstanceOf(CustomCommandRuntimeAdapter);
    await adapter.spawnTurn({
      messages: [],
    });

    expect(calls).toEqual([
      {
        command: "node",
        args: ["worker.js", "--direct"],
      },
    ]);
  });
});
