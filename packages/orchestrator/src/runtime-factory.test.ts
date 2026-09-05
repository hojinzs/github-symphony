import { EventEmitter } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { parseWorkflowMarkdown } from "@gh-symphony/core";
import { ClaudePrintRuntimeAdapter } from "@gh-symphony/runtime-claude";
import { CodexRuntimeAdapter } from "@gh-symphony/runtime-codex";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWorkflowRuntimeAdapter,
  CustomCommandRuntimeAdapter,
} from "./runtime-factory.js";
import type { SpawnLike } from "@gh-symphony/runtime-claude";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function createTempWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "runtime-factory-"));
  tempRoots.push(workspace);
  return workspace;
}

function parseWorkflow(frontMatter: string) {
  return parseWorkflowMarkdown(`---
tracker:
  kind: github-project
  provider:
    state_field: Status
  active_states:
    - Ready
  terminal_states:
    - Done
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
  it.each([
    ["legacy fallback", `codex:\n  command: codex app-server\n`],
    ["codex runtime", `runtime:\n  kind: codex-app-server\n`],
  ])(
    "strips adapter-declared tracker secrets from the %s child",
    async (_label, frontMatter) => {
      const workingDirectory = await createTempWorkspace();
      const workflow = parseWorkflow(frontMatter);
      const adapter = createWorkflowRuntimeAdapter(workflow, {
        projectId: "project-1",
        workingDirectory,
        env: {
          GITHUB_TOKEN: "host-secret",
          SYMPHONY_TRACKER_SECRET_ENVIRONMENT_NAMES: '["GITHUB_TOKEN"]',
        },
      });

      expect(adapter).toBeInstanceOf(CodexRuntimeAdapter);
      const codexAdapter = adapter as CodexRuntimeAdapter;
      await codexAdapter.prepare();

      expect(codexAdapter.getPreparedPlan()?.env.GITHUB_TOKEN).toBeUndefined();
    }
  );

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
    const workingDirectory = await createTempWorkspace();
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
      workingDirectory,
    });

    expect(adapter).toBeInstanceOf(CodexRuntimeAdapter);
    const codexAdapter = adapter as CodexRuntimeAdapter;
    await codexAdapter.prepare();

    const plan = codexAdapter.getPreparedPlan();
    expect(plan?.command).toBe("codex");
    expect(plan?.args).toEqual(["app-server", "--model", "gpt-5"]);
  });

  it("uses the default codex-app-server command when runtime command is absent", async () => {
    const workingDirectory = await createTempWorkspace();
    const workflow = parseWorkflow(`runtime:
  kind: codex-app-server
`);

    const adapter = createWorkflowRuntimeAdapter(workflow, {
      projectId: "project-1",
      workingDirectory,
    });

    expect(adapter).toBeInstanceOf(CodexRuntimeAdapter);
    const codexAdapter = adapter as CodexRuntimeAdapter;
    await codexAdapter.prepare();

    const plan = codexAdapter.getPreparedPlan();
    expect(plan?.command).toBe("codex");
    expect(plan?.args).toEqual(["app-server"]);
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
    await adapter.spawnTurn({});

    expect(calls[0]).toEqual([
      "-p",
      "--verbose",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--include-partial-messages",
      "--permission-mode",
      "bypassPermissions",
      "--bare",
      "--strict-mcp-config",
      "--mcp-config",
      "/tmp/ephemeral-mcp.json",
    ]);
  });

  it("passes explicit empty claude-print args through to argv construction", async () => {
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
  args: []
`);

    const adapter = createWorkflowRuntimeAdapter(workflow, {
      projectId: "project-1",
      workingDirectory: "/workspace",
      claudeDependencies: {
        spawnImpl,
      },
    });

    expect(adapter).toBeInstanceOf(ClaudePrintRuntimeAdapter);
    await adapter.spawnTurn({});

    expect(calls[0]).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--input-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--permission-mode",
      "bypassPermissions",
    ]);
  });

  it("creates a custom adapter that spawns command and args exactly", async () => {
    const workspace = await createTempWorkspace();
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
      workingDirectory: workspace,
      claudeDependencies: {
        spawnImpl,
      },
    });

    expect(adapter).toBeInstanceOf(CustomCommandRuntimeAdapter);
    const unsubscribe = adapter.onEvent(() => undefined);
    expect(unsubscribe()).toBeUndefined();

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

  it("prepares an isolated custom child home before spawning a rendered prompt", async () => {
    const workspace = await createTempWorkspace();
    const runtimeDirectory = join(workspace, "runtime");
    const { child, stdout, stderr } = createStubChild();
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    const workflow = parseWorkflow(`runtime:
  kind: custom
  command: node
  args: []
`);
    const adapter = createWorkflowRuntimeAdapter(workflow, {
      projectId: "project-1",
      workingDirectory: workspace,
      runtimeDirectory,
      env: { GITHUB_TOKEN: "host-secret" },
      claudeDependencies: {
        spawnImpl: (_command, _args, options) => {
          spawnedEnv = options.env;
          queueMicrotask(() => {
            stdout.end();
            stderr.end();
            child.emit("close", 0, null);
          });
          return child;
        },
      },
    });

    await adapter.spawnTurn({ messages: [], prompt: "rendered prompt" });

    expect(spawnedEnv).toMatchObject({
      HOME: join(runtimeDirectory, "child-home"),
      USERPROFILE: join(runtimeDirectory, "child-home"),
      GH_CONFIG_DIR: join(runtimeDirectory, "child-home", "gh"),
      SYMPHONY_RENDERED_PROMPT: "rendered prompt",
    });
    expect(spawnedEnv?.GITHUB_TOKEN).toBeUndefined();
    await expect(
      access(join(runtimeDirectory, "child-home"))
    ).resolves.toBeUndefined();
  });
});
