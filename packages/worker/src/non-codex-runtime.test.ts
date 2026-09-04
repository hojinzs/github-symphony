import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
          SYMPHONY_RENDERED_PROMPT: "implement issue",
        }),
      })
    );
    const spawnedEnv = spawnImpl.mock.calls[0]?.[2]?.env;
    expect(spawnedEnv?.EXISTING_ENV).toBeUndefined();
    expect(spawnedEnv?.TURN_ENV).toBeUndefined();
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
        env: {
          SYMPHONY_ASSIGNED_BRANCH: "symphony/acme-42",
          SYMPHONY_ISSUE_IDENTIFIER: "acme/repo#42",
          GITHUB_GRAPHQL_TOKEN: "tracker-secret",
          GITHUB_TOKEN_BROKER_SECRET: "broker-secret",
        },
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
    const spawnedEnv = spawnImpl.mock.calls[0]?.[2]?.env;
    expect(spawnedEnv).toMatchObject({
      SYMPHONY_ASSIGNED_BRANCH: "symphony/acme-42",
      SYMPHONY_ISSUE_IDENTIFIER: "acme/repo#42",
    });
    expect(spawnedEnv?.GITHUB_GRAPHQL_TOKEN).toBeUndefined();
    expect(spawnedEnv?.GITHUB_TOKEN_BROKER_SECRET).toBeUndefined();
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

  it("isolates custom children while forwarding only declared authentication", async () => {
    const fake = createFakeChild();
    const spawnImpl = vi.fn(() => fake.child);
    const root = await mkdtemp(join(tmpdir(), "worker-custom-runtime-"));
    const hostHome = join(root, "operator-home");
    const runtimeDirectory = join(root, "runtime");
    await mkdir(join(hostHome, ".config", "gh"), { recursive: true });
    await writeFile(
      join(hostHome, ".config", "gh", "hosts.yml"),
      "github.com:\n    user: operator\n"
    );
    const adapter = createWorkerNonCodexRuntimeAdapter(
      workflowWithRuntime("custom", "agent", ["--flag"], "CUSTOM_AGENT_TOKEN"),
      {
        workingDirectory: "/repo",
        env: {
          HOME: hostHome,
          GH_CONFIG_DIR: join(hostHome, ".config", "gh"),
          WORKSPACE_RUNTIME_DIR: runtimeDirectory,
          CUSTOM_AGENT_TOKEN: "custom-runtime-token",
          SYMPHONY_TRACKER_KIND: "github",
          SYMPHONY_ASSIGNED_BRANCH: "symphony/acme-42",
          SYMPHONY_ISSUE_IDENTIFIER: "acme/repo#42",
          GITHUB_TOKEN_BROKER_URL: "https://broker.example/runtime-credentials",
          GITHUB_TOKEN_BROKER_SECRET: "broker-secret",
          AGENT_CREDENTIAL_BROKER_URL:
            "https://broker.example/agent-credentials",
          AGENT_CREDENTIAL_BROKER_SECRET: "agent-broker-secret",
          AGENT_CREDENTIAL_CACHE_PATH: "/runtime/agent-credentials.json",
          GIT_CONFIG_KEY_0: "credential.helper",
          GIT_CONFIG_VALUE_0: "!/operator/credential-helper",
          SYMPHONY_TRACKER_SECRET_ENVIRONMENT_NAMES: JSON.stringify([
            "GITHUB_GRAPHQL_TOKEN",
            "LINEAR_API_KEY",
            "CUSTOM_TRACKER_SECRET",
          ]),
          GITHUB_GRAPHQL_TOKEN: "raw-secret",
          LINEAR_API_KEY: "linear-secret",
          LINEAR_AUTHORIZATION: "linear-authorization",
          CUSTOM_TRACKER_SECRET: "custom-tracker-secret",
        },
        runtimeDirectory,
        customDependencies: { spawnImpl },
      }
    );

    await adapter.prepare({ runId: "run-1" });
    await expect(
      readFile(join(runtimeDirectory, "child-home", "gh", "hosts.yml"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    const resultPromise = adapter.spawnTurn({ prompt: "implement issue" });
    fake.stdout.end();
    fake.stderr.end();
    fake.emitExit(0, null);
    await resultPromise;

    const spawnedEnv = spawnImpl.mock.calls[0]?.[2]?.env;
    expect(spawnedEnv).toMatchObject({
      CUSTOM_AGENT_TOKEN: "custom-runtime-token",
      SYMPHONY_ASSIGNED_BRANCH: "symphony/acme-42",
      SYMPHONY_ISSUE_IDENTIFIER: "acme/repo#42",
      HOME: join(runtimeDirectory, "child-home"),
      GH_CONFIG_DIR: join(runtimeDirectory, "child-home", "gh"),
    });
    for (const name of [
      "GITHUB_GRAPHQL_TOKEN",
      "LINEAR_API_KEY",
      "LINEAR_AUTHORIZATION",
      "CUSTOM_TRACKER_SECRET",
      "GITHUB_TOKEN_BROKER_URL",
      "GITHUB_TOKEN_BROKER_SECRET",
      "AGENT_CREDENTIAL_BROKER_URL",
      "AGENT_CREDENTIAL_BROKER_SECRET",
      "AGENT_CREDENTIAL_CACHE_PATH",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
    ]) {
      expect(spawnedEnv?.[name]).toBeUndefined();
    }
  });
});

function workflowWithRuntime(
  kind: "claude-print" | "custom",
  command: string,
  args: readonly string[],
  authEnv: string | null = null
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
        trustRepoConfig: false,
        inheritEnvironment: false,
      },
      auth: {
        env: authEnv,
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
