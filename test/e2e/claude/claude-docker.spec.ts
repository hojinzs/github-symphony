import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClaudePrintRuntimeAdapter } from "@gh-symphony/runtime-claude";
import type { AgentEvent } from "@gh-symphony/core";
import { CustomCommandWorkerRuntimeAdapter } from "../../../packages/worker/src/non-codex-runtime.js";

type Invocation = {
  invocation: number;
  scenario: string;
  argv: string[];
  stdin: string[];
  sessionId: string | null;
  resumeId: string | null;
  forkSession: boolean;
  resultSessionId: string;
  hostMcp: {
    url: string;
    responseStatus: number;
    result?: {
      content?: Array<{ type: string; text: string }>;
    };
    calls?: Array<{
      status: number;
      payload: { result?: unknown; error?: unknown };
    }>;
    error?: { code: number; message: string };
  } | null;
  childBoundary: {
    home: string | null;
    ghConfigDir: string | null;
    gitConfigCount: boolean;
    gitCredentialHelper: boolean;
  };
  trackerCredentialEnvironment: {
    githubGraphqlToken: boolean;
    githubToken: boolean;
    ghToken: boolean;
    githubTokenBrokerSecret: boolean;
    linearApiKey: boolean;
    linearAuthorization: boolean;
  };
};

type IssueFixture = {
  id: string;
  identifier: string;
  state: string;
  metadata: Record<string, unknown>;
};

const __dirname = resolve(fileURLToPath(new URL(".", import.meta.url)));
const repoRoot = resolve(__dirname, "../../..");
const stubPath = resolve(repoRoot, "test/e2e/stubs/claude.sh");
const stubWrapperPath = resolve(repoRoot, "test/e2e/stubs/claude");
const createdRoots: string[] = [];
const createdServers: Array<() => Promise<void>> = [];
const execFileAsync = promisify(execFile);

beforeAll(async () => {
  await chmodExecutable(stubPath);
  await chmodExecutable(stubWrapperPath);
});

afterEach(async () => {
  await Promise.all(createdServers.splice(0).map((close) => close()));
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

describe("Claude Docker E2E with stub claude binary", () => {
  it.each([
    { name: "default isolation", inheritEnvironment: false },
    { name: "compatibility mode", inheritEnvironment: true },
  ])(
    "runs a real custom child with $name credential semantics",
    async ({ inheritEnvironment }) => {
      const root = await mkdtemp(join(tmpdir(), "worker-custom-e2e-"));
      createdRoots.push(root);
      const workspace = join(root, "workspace");
      const runtimeDirectory = join(root, "runtime");
      const hostHome = join(root, "operator-home");
      const outputPath = join(root, "custom-child.json");
      const commandPath = join(root, "custom-child.cjs");
      await mkdir(join(hostHome, ".config", "gh"), { recursive: true });
      await mkdir(workspace, { recursive: true });
      await writeFile(
        join(hostHome, ".config", "gh", "hosts.yml"),
        "github.com:\n  oauth_token: operator-secret\n"
      );
      await writeFile(
        join(hostHome, ".gitconfig"),
        "[user]\n  name = Operator\n[credential]\n  helper = store\n"
      );
      await writeFile(
        commandPath,
        `const fs = require("node:fs");
const path = require("node:path");
const env = process.env;
fs.writeFileSync(process.argv[2], JSON.stringify({
  customAuth: env.CUSTOM_AGENT_TOKEN ?? null,
  githubToken: env.GITHUB_TOKEN ?? null,
  linearApiKey: env.LINEAR_API_KEY ?? null,
  githubBrokerSecret: env.GITHUB_TOKEN_BROKER_SECRET ?? null,
  agentBrokerSecret: env.AGENT_CREDENTIAL_BROKER_SECRET ?? null,
  trackerSecret: env.TRACKER_SECRET ?? null,
  home: env.HOME ?? null,
  userProfile: env.USERPROFILE ?? null,
  ghConfigDir: env.GH_CONFIG_DIR ?? null,
  hostGhAuthVisible: fs.existsSync(path.join(env.HOME, ".config", "gh", "hosts.yml")),
  childGhAuthVisible: fs.existsSync(path.join(env.GH_CONFIG_DIR, "hosts.yml")),
  gitIdentityVisible: fs.existsSync(path.join(env.HOME, ".gitconfig")) && fs.readFileSync(path.join(env.HOME, ".gitconfig"), "utf8").includes("name = Operator"),
  gitCredentialHelperVisible: fs.existsSync(path.join(env.HOME, ".gitconfig")) && fs.readFileSync(path.join(env.HOME, ".gitconfig"), "utf8").includes("helper = store"),
  gitConfigInjectionVisible: Boolean(env.GIT_CONFIG_KEY_0 || env.GIT_CONFIG_VALUE_0),
  prompt: env.SYMPHONY_RENDERED_PROMPT ?? null,
}));
`,
        "utf8"
      );
      const adapter = new CustomCommandWorkerRuntimeAdapter({
        workingDirectory: workspace,
        command: process.execPath,
        args: [commandPath, outputPath],
        runtimeDirectory,
        inheritEnvironment,
        authEnvKey: "CUSTOM_AGENT_TOKEN",
        env: {
          PATH: process.env.PATH,
          HOME: hostHome,
          USERPROFILE: hostHome,
          GH_CONFIG_DIR: join(hostHome, ".config", "gh"),
          CUSTOM_AGENT_TOKEN: "custom-agent-token",
          GITHUB_TOKEN: "github-token",
          LINEAR_API_KEY: "linear-token",
          GITHUB_TOKEN_BROKER_SECRET: "github-broker-secret",
          AGENT_CREDENTIAL_BROKER_SECRET: "agent-broker-secret",
          GIT_CONFIG_KEY_0: "credential.helper",
          GIT_CONFIG_VALUE_0: "store",
          SYMPHONY_TRACKER_SECRET_ENVIRONMENT_NAMES: JSON.stringify([
            "TRACKER_SECRET",
          ]),
          TRACKER_SECRET: "tracker-secret",
        },
      });

      await adapter.prepare();
      const result = await adapter.spawnTurn({ prompt: "custom E2E prompt" });
      expect(result).toMatchObject({ result: "success" });
      const child = JSON.parse(await readFile(outputPath, "utf8")) as Record<
        string,
        string | boolean | null
      >;

      expect(child).toMatchObject({
        customAuth: "custom-agent-token",
        home: join(runtimeDirectory, "child-home"),
        userProfile: join(runtimeDirectory, "child-home"),
        ghConfigDir: join(runtimeDirectory, "child-home", "gh"),
        hostGhAuthVisible: false,
        childGhAuthVisible: false,
        gitIdentityVisible: true,
        gitCredentialHelperVisible: false,
        gitConfigInjectionVisible: false,
        prompt: "custom E2E prompt",
      });
      const rawSecretValues = {
        githubToken: "github-token",
        linearApiKey: "linear-token",
        githubBrokerSecret: "github-broker-secret",
        agentBrokerSecret: "agent-broker-secret",
        trackerSecret: "tracker-secret",
      } as const;
      for (const name of Object.keys(rawSecretValues)) {
        expect(child[name]).toBeNull();
      }
    }
  );

  it("processes one issue from Ready to In progress to In review", async () => {
    const harness = await createHarness("success");
    const issue: IssueFixture = {
      id: "issue-claude-success",
      identifier: "test-owner/test-repo#224",
      state: "Ready",
      metadata: {},
    };
    await harness.writeIssues([issue]);

    await harness.transitionIssue(issue.id, "In progress");
    const result = await harness.runTurn("run-success", {
      messages: { type: "user", text: "Handle one E2E issue." },
    });
    expect(result.result).toBe("success");
    await harness.transitionIssue(issue.id, "In review");

    const [updatedIssue] = await harness.readIssues();
    expect(updatedIssue?.state).toBe("In review");
    expect(await harness.readIssueStatusEvents()).toEqual([
      "Ready",
      "In progress",
      "In review",
    ]);
    expect(await harness.readInvocations()).toHaveLength(1);
  });

  it("routes worker claude-print runtime through the adapter lifecycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "worker-claude-e2e-"));
    createdRoots.push(root);
    const workspace = join(root, "workspace");
    const runtimeRoot = join(root, "runtime");
    const logDir = join(root, "stub-log");
    const workflowPath = join(workspace, "WORKFLOW.md");
    await mkdir(workspace, { recursive: true });
    await mkdir(runtimeRoot, { recursive: true });
    await mkdir(logDir, { recursive: true });
    await writeFile(
      workflowPath,
      `---
tracker:
  kind: github-project
runtime:
  kind: claude-print
  command: claude
---
Worker prompt.
`,
      "utf8"
    );
    const remote = join(root, "remote.git");
    await runGit(root, "init", "--bare", remote);
    await runGit(remote, "config", "http.receivepack", "true");
    await runGit(workspace, "init", "-b", "feat/assigned");
    await runGit(workspace, "config", "user.name", "Symphony E2E");
    await runGit(workspace, "config", "user.email", "e2e@example.com");
    await runGit(workspace, "add", "WORKFLOW.md");
    await runGit(workspace, "commit", "-m", "test: seed Claude workspace");
    await runGit(workspace, "remote", "add", "origin", remote);
    await runGit(workspace, "push", "origin", "feat/assigned");
    const authenticatedGitServer = await createAuthenticatedGitServer(
      root,
      "stub-token"
    );
    createdServers.push(authenticatedGitServer.close);
    const authenticatedRemoteUrl = `${authenticatedGitServer.url}/${remote.slice(root.length + 1)}`;
    await runGit(
      workspace,
      "remote",
      "set-url",
      "origin",
      authenticatedRemoteUrl
    );
    await runGit(
      workspace,
      "commit",
      "--allow-empty",
      "-m",
      "test: exercise authenticated Claude push"
    );
    const fetchMockPath = join(root, "host-mcp-fetch-mock.cjs");
    await writeFile(
      fetchMockPath,
      `const fs = require("fs");
const originalFetch = global.fetch;
global.fetch = async (url, options) => {
  if (String(url) !== "https://api.github.com/graphql") {
    return originalFetch(url, options);
  }
  const authorization = options?.headers?.authorization;
  fs.appendFileSync(process.env.CLAUDE_STUB_LOG_DIR + "/host-fetch.ndjson", JSON.stringify({
    hostCredentialUsed: authorization === "Bearer stub-token",
    body: options?.body,
  }) + "\\n");
  const body = String(options?.body);
  const payload = body.includes("addComment")
    ? { data: { addComment: { commentEdge: { node: { id: "comment-claude" } } } } }
    : body.includes("updateProjectV2ItemFieldValue")
      ? { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "item-worker-claude" } } } }
      : { data: { viewer: { login: "host-mcp-stub" } } };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
`,
      "utf8"
    );

    const workerEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${resolve(repoRoot, "test/e2e/stubs")}:${process.env.PATH ?? ""}`,
      CLAUDE_STUB_LOG_DIR: logDir,
      CLAUDE_STUB_SCENARIO: "success",
      CLAUDE_STUB_CALL_HOST_MCP: "true",
      NODE_OPTIONS: `--require ${fetchMockPath}`,
      ANTHROPIC_API_KEY: "stub-anthropic-key",
      GITHUB_GRAPHQL_TOKEN: "stub-token",
      GITHUB_TOKEN: "stub-github-token",
      GH_TOKEN: "stub-gh-token",
      GITHUB_TOKEN_BROKER_URL: "https://broker.example/runtime-credentials",
      GITHUB_TOKEN_BROKER_SECRET: "stub-broker-secret",
      GITHUB_GIT_HOST: authenticatedGitServer.host,
      GIT_SSL_NO_VERIFY: "1",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "",
      LINEAR_API_KEY: "stub-linear-api-key",
      LINEAR_AUTHORIZATION: "Bearer stub-linear-authorization",
      SYMPHONY_TRACKER_SECRET_ENVIRONMENT_NAMES: JSON.stringify([
        "GITHUB_GRAPHQL_TOKEN",
        "GITHUB_TOKEN",
        "GH_TOKEN",
        "GITHUB_TOKEN_BROKER_SECRET",
        "LINEAR_API_KEY",
        "LINEAR_AUTHORIZATION",
      ]),
      GITHUB_PROJECT_ID: "stub-project",
      WORKING_DIRECTORY: workspace,
      SYMPHONY_ASSIGNED_BRANCH: "feat/assigned",
      TARGET_REPOSITORY_CLONE_URL: authenticatedRemoteUrl,
      WORKSPACE_RUNTIME_DIR: runtimeRoot,
      SYMPHONY_WORKFLOW_PATH: workflowPath,
      SYMPHONY_RENDERED_PROMPT: "Handle worker runtime adapter issue.",
      SYMPHONY_RUN_ID: "run-worker-claude",
      SYMPHONY_ISSUE_ID: "issue-worker-claude",
      SYMPHONY_ISSUE_IDENTIFIER: "test-owner/test-repo#254",
      SYMPHONY_ISSUE_NATIVE_REF: JSON.stringify({
        itemId: "item-worker-claude",
      }),
      SYMPHONY_ISSUE_STATE: "In progress",
      SYMPHONY_MAX_TURNS: "2",
      SYMPHONY_CONTINUATION_GUIDANCE: "Continue with the same Claude session.",
    };
    const leaseServer = await createTurnLeaseServer();
    let result: Awaited<ReturnType<typeof runWorkerProcess>>;
    try {
      result = await runWorkerProcess({
        cwd: repoRoot,
        env: {
          ...workerEnv,
          SYMPHONY_ORCHESTRATOR_URL: leaseServer.url,
          SYMPHONY_ORCHESTRATOR_TOKEN: "stub-orchestrator-token",
        },
      });
    } finally {
      await leaseServer.close();
    }

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toContain("Claude runtime preflight");
    expect(result.stderr).toContain("claude-print/result");
    expect(result.stderr).toContain('"type":"turn_completed"');
    expect(result.stderr).not.toContain("sending codex initialize");
    expect(result.stderr).not.toContain("codex client protocol");
    const invocations = await readStubInvocations(logDir);
    // Claude preflight invokes the stub once before the adapter-launched child.
    // Claude preflight invokes the stub once; SYMPHONY_MAX_TURNS=2 must
    // produce exactly two worker turns and no third continuation turn.
    expect(invocations.length).toBe(3);
    const workerInvocations = invocations.slice(-2);
    expect(workerInvocations[1]?.argv).toContain("--resume");
    expect(workerInvocations[1]?.argv).not.toContain("--fork-session");
    expect(workerInvocations[1]?.stdin.join("\n")).toContain(
      "Continue with the same Claude session."
    );
    expect(invocations.at(-1)?.trackerCredentialEnvironment).toEqual({
      githubGraphqlToken: false,
      githubToken: false,
      ghToken: false,
      githubTokenBrokerSecret: false,
      linearApiKey: false,
      linearAuthorization: false,
    });
    expect(invocations.at(-1)?.childBoundary).toEqual({
      home: join(runtimeRoot, "child-home"),
      ghConfigDir: join(runtimeRoot, "child-home", "gh"),
      gitConfigCount: false,
      gitCredentialHelper: false,
    });
    expect(invocations.at(-1)?.hostMcp).toMatchObject({
      url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/),
      responseStatus: 200,
      result: {
        content: [
          expect.objectContaining({
            text: expect.stringContaining("item-worker-claude"),
          }),
        ],
      },
    });
    const hostFetches = (
      await readFile(join(logDir, "host-fetch.ndjson"), "utf8")
    )
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { hostCredentialUsed: boolean; body: string }
      );
    // The fixture runs two Claude turns, each issuing query/comment/state calls.
    expect(hostFetches).toHaveLength(6);
    expect(hostFetches.every((entry) => entry.hostCredentialUsed)).toBe(true);
    expect(hostFetches.map((entry) => entry.body).join("\n")).toContain(
      "addComment"
    );
    expect(hostFetches.map((entry) => entry.body).join("\n")).toContain(
      "updateProjectV2ItemFieldValue"
    );
    expect(result.stderr).toContain("host MCP server started");
    expect(result.stderr).toContain("host MCP server stopped");
    expect(result.stderr).toContain("host Git transport pushed feat/assigned");
    expect(authenticatedGitServer.authenticatedPaths).toEqual(
      expect.arrayContaining([
        "/remote.git/info/refs?service=git-receive-pack",
        "/remote.git/git-receive-pack",
      ])
    );

    const competing = join(root, "competing");
    await runGit(root, "clone", remote, competing);
    await runGit(competing, "switch", "feat/assigned");
    await runGit(competing, "config", "user.name", "Symphony E2E");
    await runGit(competing, "config", "user.email", "e2e@example.com");
    await runGit(competing, "commit", "--allow-empty", "-m", "remote race");
    await runGit(competing, "push", "origin", "feat/assigned");
    await runGit(workspace, "commit", "--allow-empty", "-m", "agent commit");

    const failureLeaseServer = await createTurnLeaseServer();
    let failureResult: Awaited<ReturnType<typeof runWorkerProcess>>;
    try {
      failureResult = await runWorkerProcess({
        cwd: repoRoot,
        env: {
          ...workerEnv,
          CLAUDE_STUB_CALL_HOST_MCP: "false",
          SYMPHONY_RUN_ID: "run-worker-claude-transport-failure",
          SYMPHONY_MAX_TURNS: "1",
          SYMPHONY_ORCHESTRATOR_URL: failureLeaseServer.url,
          SYMPHONY_ORCHESTRATOR_TOKEN: "stub-orchestrator-token",
        },
      });
    } finally {
      await failureLeaseServer.close();
    }

    expect(failureResult.exitCode).toBe(1);
    expect(failureResult.stderr).toContain(
      '"runPhase":"failed","lastError":"git_transport_failed:'
    );
    expect(failureResult.stderr).toContain(
      "origin/feat/assigned is not an ancestor"
    );
  });

  it("fails the Codex worker lifecycle when post-run Git transport cannot publish", async () => {
    const root = await mkdtemp(join(tmpdir(), "worker-codex-transport-e2e-"));
    createdRoots.push(root);
    const workspace = join(root, "workspace");
    const runtimeRoot = join(root, "runtime");
    const binDir = join(root, "bin");
    const workflowPath = join(workspace, "WORKFLOW.md");
    await mkdir(workspace, { recursive: true });
    await mkdir(runtimeRoot, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(
      workflowPath,
      `---
tracker:
  kind: github-project
runtime:
  kind: codex-app-server
  command: codex app-server
agent:
  max_turns: 1
---
Worker prompt.
`,
      "utf8"
    );
    const codexStub = join(binDir, "codex");
    await writeFile(
      codexStub,
      `#!/usr/bin/env node
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: { serverInfo: { name: "codex-stub", version: "1" } } });
  } else if (message.method === "thread/start") {
    send({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "thread-stub" } } });
  } else if (message.method === "turn/start") {
    send({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "turn-stub" } } });
    setTimeout(() => send({ jsonrpc: "2.0", method: "turn/completed", params: {} }), 10);
  }
});
`,
      "utf8"
    );
    await chmodExecutable(codexStub);

    const remote = join(root, "remote.git");
    await runGit(root, "init", "--bare", remote);
    await runGit(workspace, "init", "-b", "feat/assigned");
    await runGit(workspace, "config", "user.name", "Symphony E2E");
    await runGit(workspace, "config", "user.email", "e2e@example.com");
    await runGit(workspace, "add", "WORKFLOW.md");
    await runGit(workspace, "commit", "-m", "test: seed Codex workspace");
    await runGit(workspace, "remote", "add", "origin", remote);
    await runGit(workspace, "push", "origin", "feat/assigned");
    const competing = join(root, "competing");
    await runGit(root, "clone", remote, competing);
    await runGit(competing, "switch", "feat/assigned");
    await runGit(competing, "config", "user.name", "Symphony E2E");
    await runGit(competing, "config", "user.email", "e2e@example.com");
    await runGit(competing, "commit", "--allow-empty", "-m", "remote race");
    await runGit(competing, "push", "origin", "feat/assigned");
    await runGit(workspace, "commit", "--allow-empty", "-m", "agent commit");

    const leaseServer = await createTurnLeaseServer();
    let result: Awaited<ReturnType<typeof runWorkerProcess>>;
    try {
      result = await runWorkerProcess({
        cwd: repoRoot,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          CODEX_PROJECT_ID: "e2e-project",
          OPENAI_API_KEY: "stub-openai-key",
          WORKING_DIRECTORY: workspace,
          SYMPHONY_ASSIGNED_BRANCH: "feat/assigned",
          TARGET_REPOSITORY_CLONE_URL: remote,
          WORKSPACE_RUNTIME_DIR: runtimeRoot,
          SYMPHONY_WORKFLOW_PATH: workflowPath,
          SYMPHONY_RENDERED_PROMPT: "Handle worker Codex issue.",
          SYMPHONY_RUN_ID: "run-worker-codex-transport-failure",
          SYMPHONY_ISSUE_ID: "issue-worker-codex",
          SYMPHONY_ISSUE_IDENTIFIER: "test-owner/test-repo#700",
          SYMPHONY_ISSUE_STATE: "In progress",
          SYMPHONY_MAX_TURNS: "1",
          SYMPHONY_APPROVAL_POLICY: "never",
          SYMPHONY_THREAD_SANDBOX: "workspace-write",
          SYMPHONY_TURN_SANDBOX_POLICY: "dangerFullAccess",
          SYMPHONY_ORCHESTRATOR_URL: leaseServer.url,
          SYMPHONY_ORCHESTRATOR_TOKEN: "stub-orchestrator-token",
        },
      });
    } finally {
      await leaseServer.close();
    }

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("sending codex initialize");
    expect(result.stderr).toContain(
      '"runPhase":"failed","lastError":"git_transport_failed:'
    );
    expect(result.stderr).toContain("origin/feat/assigned is not an ancestor");
  });

  it("fails a built Codex worker startup with a terminal failed heartbeat", async () => {
    const root = await mkdtemp(join(tmpdir(), "worker-codex-startup-e2e-"));
    createdRoots.push(root);
    const workspace = join(root, "workspace");
    const runtimeRoot = join(root, "runtime");
    const workflowPath = join(workspace, "WORKFLOW.md");
    await mkdir(workspace, { recursive: true });
    await mkdir(runtimeRoot, { recursive: true });
    await writeFile(
      workflowPath,
      `---
tracker:
  kind: github-project
runtime:
  kind: codex-app-server
  command: codex app-server
---
Worker prompt.
`,
      "utf8"
    );
    const remote = join(root, "remote.git");
    await runGit(root, "init", "--bare", remote);
    await runGit(workspace, "init", "-b", "feat/assigned");
    await runGit(workspace, "config", "user.name", "Symphony E2E");
    await runGit(workspace, "config", "user.email", "e2e@example.com");
    await runGit(workspace, "add", "WORKFLOW.md");
    await runGit(
      workspace,
      "commit",
      "-m",
      "test: seed Codex startup workspace"
    );
    await runGit(workspace, "remote", "add", "origin", remote);
    await runGit(workspace, "push", "origin", "feat/assigned");

    const result = await runWorkerProcess({
      cwd: repoRoot,
      env: {
        ...process.env,
        PROJECT_ID: undefined,
        CODEX_PROJECT_ID: undefined,
        WORKING_DIRECTORY: workspace,
        SYMPHONY_ASSIGNED_BRANCH: "feat/assigned",
        TARGET_REPOSITORY_CLONE_URL: remote,
        WORKSPACE_RUNTIME_DIR: runtimeRoot,
        SYMPHONY_WORKFLOW_PATH: workflowPath,
        SYMPHONY_RENDERED_PROMPT: "Handle worker Codex startup issue.",
        SYMPHONY_RUN_ID: "run-worker-codex-startup-failure",
        SYMPHONY_ISSUE_ID: "issue-worker-codex-startup",
        SYMPHONY_ISSUE_IDENTIFIER: "test-owner/test-repo#779",
        SYMPHONY_ISSUE_STATE: "In progress",
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "[worker] startup failed: PROJECT_ID or CODEX_PROJECT_ID is required."
    );
    const heartbeats = result.stderr
      .split("\n")
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter((payload): payload is Record<string, unknown> => payload !== null)
      .filter((payload) => payload.type === "heartbeat");
    expect(heartbeats.at(-1)).toMatchObject({
      issueId: "issue-worker-codex-startup",
      runPhase: "failed",
      lastError: "startup failed: PROJECT_ID or CODEX_PROJECT_ID is required.",
    });

    const credentialResult = await runWorkerProcess({
      cwd: repoRoot,
      env: {
        ...process.env,
        PROJECT_ID: "e2e-project",
        CODEX_PROJECT_ID: undefined,
        GITHUB_GRAPHQL_TOKEN: undefined,
        GITHUB_TOKEN_BROKER_URL: undefined,
        GITHUB_TOKEN_BROKER_SECRET: undefined,
        WORKING_DIRECTORY: workspace,
        SYMPHONY_ASSIGNED_BRANCH: "feat/assigned",
        SYMPHONY_TRACKER_ADAPTER: "github-project",
        SYMPHONY_PROJECT_DIR: join(runtimeRoot, "managed-project"),
        TARGET_REPOSITORY_CLONE_URL: remote,
        WORKSPACE_RUNTIME_DIR: runtimeRoot,
        SYMPHONY_WORKFLOW_PATH: workflowPath,
        SYMPHONY_RENDERED_PROMPT: "Handle worker credential startup issue.",
        SYMPHONY_RUN_ID: "run-worker-credential-startup-failure",
        SYMPHONY_ISSUE_ID: "issue-worker-credential-startup",
        SYMPHONY_ISSUE_IDENTIFIER: "test-owner/test-repo#813",
        SYMPHONY_ISSUE_STATE: "In progress",
      },
    });

    expect(credentialResult.exitCode).toBe(1);
    expect(credentialResult.stderr).toContain(
      "Worker GitHub credential preflight failed"
    );
    expect(credentialResult.stderr).toContain(
      `${join(runtimeRoot, "managed-project")}/.env`
    );
    expect(credentialResult.stderr).not.toContain("sending codex initialize");
  });

  it("keeps --resume within an intra-run continuation without --fork-session", async () => {
    const harness = await createHarness("retry-then-success");

    await harness.runTurn("run-retry", {
      messages: { type: "user", text: "Initial turn." },
    });
    await harness.runTurn("run-retry", {
      messages: { type: "user", text: "Continuation turn." },
      prepare: false,
    });

    const session = await harness.readSessionFile("run-retry");
    const invocations = await harness.readInvocations();
    expect(invocations).toHaveLength(2);
    expect(invocations[1]?.argv).toContain("--resume");
    expect(valueAfter(invocations[1]!.argv, "--resume")).toBe(
      session.sessionId
    );
    expect(invocations[1]?.argv).not.toContain("--fork-session");
    expect(invocations[1]?.resumeId).toBe(session.sessionId);
  });

  it("forks from the previous run session during inter-run recover", async () => {
    const harness = await createHarness("inter-run-recover");

    await harness.runTurn("run-prev", {
      messages: { type: "user", text: "Previous run." },
    });
    const previousSession = await harness.readSessionFile("run-prev");

    await harness.runTurn("run-next", {
      previousRunId: "run-prev",
      messages: { type: "user", text: "Recovered run." },
    });
    const nextSession = await harness.readSessionFile("run-next");
    const invocations = await harness.readInvocations();
    const recoverInvocation = invocations.at(-1);

    expect(recoverInvocation?.argv).toContain("--resume");
    expect(valueAfter(recoverInvocation!.argv, "--resume")).toBe(
      previousSession.sessionId
    );
    expect(recoverInvocation?.argv).toContain("--fork-session");
    expect(nextSession.sessionId).not.toBe(previousSession.sessionId);
    expect(nextSession.sessionId).toBe(recoverInvocation?.resultSessionId);
    expect(nextSession.parentRunId).toBe("run-prev");
  });

  it("records session_invalidated when a persisted resume session is rejected", async () => {
    const harness = await createHarness("success");

    await harness.runTurn("run-invalidated", {
      messages: { type: "user", text: "Create persisted session." },
    });
    const firstSession = await harness.readSessionFile("run-invalidated");

    harness.setScenario("session-invalid-on-resume");
    const result = await harness.runTurn("run-invalidated", {
      messages: { type: "user", text: "Resume invalid session." },
    });

    expect(result.result).toBe("success");
    const replacementSession = await harness.readSessionFile("run-invalidated");
    expect(replacementSession.sessionId).not.toBe(firstSession.sessionId);

    const events = await harness.readRunEvents("run-invalidated");
    expect(events.some((event) => event.event === "session_invalidated")).toBe(
      true
    );
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "session_invalidated",
          sessionId: firstSession.sessionId,
          replacementSessionId: replacementSession.sessionId,
        }),
      ])
    );
  });
});

async function createHarness(initialScenario: string) {
  const root = await mkdtemp(join(tmpdir(), "claude-docker-e2e-"));
  createdRoots.push(root);
  const workspace = join(root, "workspace");
  const runtimeRoot = join(root, "runtime");
  const logDir = join(root, "stub-log");
  const issuePath = join(root, "issues.json");
  const eventsByRun = new Map<string, AgentEvent[]>();
  const flushedEventCountsByRun = new Map<string, number>();
  let scenario = initialScenario;
  let lastAdapter: ReturnType<typeof createClaudePrintRuntimeAdapter> | null =
    null;

  await mkdir(workspace, { recursive: true });
  await mkdir(runtimeRoot, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const createAdapter = () => {
    const adapter = createClaudePrintRuntimeAdapter(
      {
        workingDirectory: workspace,
        runtimeRoot,
        runtimeDirectory: join(root, "workspace-runtime"),
        command: "claude",
        isolation: {
          strictMcpConfig: true,
        },
        env: {
          PATH: `${resolve(repoRoot, "test/e2e/stubs")}:${process.env.PATH ?? ""}`,
          CLAUDE_STUB_LOG_DIR: logDir,
          CLAUDE_STUB_SCENARIO: scenario,
          GITHUB_GRAPHQL_TOKEN: "stub-token",
          GITHUB_PROJECT_ID: "stub-project",
        },
      },
      {
        createSessionId: () => `generated-${randomUUID()}`,
      }
    );
    adapter.onEvent((event) => {
      const runId =
        typeof event.payload.params?.runId === "string"
          ? event.payload.params.runId
          : typeof event.payload.runId === "string"
            ? event.payload.runId
            : null;
      if (runId) {
        eventsByRun.set(runId, [...(eventsByRun.get(runId) ?? []), event]);
      }
    });
    return adapter;
  };

  return {
    root,
    setScenario(nextScenario: string) {
      scenario = nextScenario;
    },
    async writeIssues(issues: IssueFixture[]) {
      await writeFile(
        issuePath,
        `${JSON.stringify(issues, null, 2)}\n`,
        "utf8"
      );
      await appendIssueStatusEvent(root, issues[0]?.state ?? "unknown");
    },
    async readIssues(): Promise<IssueFixture[]> {
      return JSON.parse(await readFile(issuePath, "utf8")) as IssueFixture[];
    },
    async transitionIssue(issueId: string, state: string) {
      const issues = await this.readIssues();
      const updated = issues.map((issue) =>
        issue.id === issueId ? { ...issue, state } : issue
      );
      await writeFile(
        issuePath,
        `${JSON.stringify(updated, null, 2)}\n`,
        "utf8"
      );
      await appendIssueStatusEvent(root, state);
    },
    async runTurn(
      runId: string,
      input: {
        messages: Record<string, unknown> | readonly Record<string, unknown>[];
        previousRunId?: string;
        prepare?: boolean;
      }
    ) {
      const runDirectory = join(runtimeRoot, "runs", runId);
      const previousRunDirectory = input.previousRunId
        ? join(runtimeRoot, "runs", input.previousRunId)
        : undefined;
      await mkdir(runDirectory, { recursive: true });

      if (input.prepare !== false || !lastAdapter) {
        lastAdapter = createAdapter();
        await lastAdapter.prepare({
          runId,
          runDirectory,
          previousRunId: input.previousRunId,
          previousRunDirectory,
        });
      }

      const result = await lastAdapter.spawnTurn({ messages: input.messages });
      const events = eventsByRun.get(runId) ?? [];
      const flushedEventCount = flushedEventCountsByRun.get(runId) ?? 0;
      const newEvents = events.slice(flushedEventCount);
      await appendRunEvents(runDirectory, result.args, newEvents);
      flushedEventCountsByRun.set(runId, events.length);
      return result;
    },
    async readSessionFile(runId: string) {
      return JSON.parse(
        await readFile(
          join(runtimeRoot, "runs", runId, "claude-session.json"),
          "utf8"
        )
      ) as {
        sessionId: string;
        parentRunId?: string;
      };
    },
    async readInvocations(): Promise<Invocation[]> {
      const raw = await readFile(join(logDir, "invocations.ndjson"), "utf8");
      return raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Invocation);
    },
    async readRunEvents(runId: string) {
      const raw = await readFile(
        join(runtimeRoot, "runs", runId, "events.ndjson"),
        "utf8"
      );
      return raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    async readIssueStatusEvents() {
      const raw = await readFile(join(root, "issue-status.ndjson"), "utf8");
      return raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => (JSON.parse(line) as { status: string }).status);
    },
  };
}

async function appendIssueStatusEvent(root: string, status: string) {
  const path = join(root, "issue-status.ndjson");
  const existing = await readOptional(path);
  await writeFile(
    path,
    `${existing}${JSON.stringify({ event: "issue_status", status })}\n`,
    "utf8"
  );
}

async function readStubInvocations(logDir: string): Promise<Invocation[]> {
  const raw = await readFile(join(logDir, "invocations.ndjson"), "utf8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Invocation);
}

async function appendRunEvents(
  runDirectory: string,
  argv: readonly string[],
  events: readonly AgentEvent[]
) {
  const path = join(runDirectory, "events.ndjson");
  const existing = await readOptional(path);
  const records = [
    {
      event: "argv_snapshot",
      argv,
    },
    ...events.map((event) => ({
      event: event.payload.observabilityEvent ?? event.name,
      name: event.name,
      ...event.payload,
    })),
  ];
  await writeFile(
    path,
    existing +
      records.map((record) => JSON.stringify(record)).join("\n") +
      "\n",
    "utf8"
  );
}

async function readOptional(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return "";
    }
    throw error;
  }
}

async function createAuthenticatedGitServer(
  projectRoot: string,
  token: string
) {
  const authenticatedPaths: string[] = [];
  const expectedAuthorization = `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
  const keyPath = join(projectRoot, "git-server-key.pem");
  const certificatePath = join(projectRoot, "git-server-cert.pem");
  await execFileAsync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    keyPath,
    "-out",
    certificatePath,
    "-subj",
    "/CN=127.0.0.1",
    "-days",
    "1",
  ]);
  const server = createHttpsServer(
    {
      key: await readFile(keyPath),
      cert: await readFile(certificatePath),
    },
    (request, response) => {
      if (request.headers.authorization !== expectedAuthorization) {
        response.writeHead(401, { "www-authenticate": 'Basic realm="Git"' });
        response.end();
        return;
      }
      authenticatedPaths.push(request.url ?? "");
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      const backend = spawn("git", ["http-backend"], {
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: projectRoot,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: requestUrl.pathname,
          QUERY_STRING: requestUrl.search.slice(1),
          REQUEST_METHOD: request.method ?? "GET",
          CONTENT_TYPE: request.headers["content-type"] ?? "",
          CONTENT_LENGTH: request.headers["content-length"] ?? "",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let responded = false;
      const fail = (message: Buffer | string) => {
        if (responded) return;
        responded = true;
        response.writeHead(500);
        response.end(message);
      };
      backend.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      backend.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      backend.stdin.once("error", (error) => fail(error.message));
      backend.once("error", (error) => fail(error.message));
      backend.once("close", (exitCode) => {
        if (responded) return;
        const output = Buffer.concat(stdout);
        const separator = output.indexOf("\r\n\r\n");
        if (exitCode !== 0 || separator === -1) {
          fail(Buffer.concat(stderr));
          return;
        }
        const headerLines = output
          .subarray(0, separator)
          .toString("utf8")
          .split("\r\n");
        let status = 200;
        const headers: Record<string, string> = {};
        for (const line of headerLines) {
          const colon = line.indexOf(":");
          if (colon === -1) continue;
          const name = line.slice(0, colon).trim();
          const value = line.slice(colon + 1).trim();
          if (name.toLowerCase() === "status") {
            status = Number.parseInt(value, 10);
          } else {
            headers[name] = value;
          }
        }
        responded = true;
        response.writeHead(status, headers);
        response.end(output.subarray(separator + 4));
      });
      request.pipe(backend.stdin);
    }
  );
  await new Promise<void>((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectServer);
      resolveServer();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    authenticatedPaths,
    host: `127.0.0.1:${address.port}`,
    url: `https://127.0.0.1:${address.port}`,
    close: () => {
      const closed = new Promise<void>((resolveClose) =>
        server.close(() => resolveClose())
      );
      server.closeAllConnections();
      return closed;
    },
  };
}

async function runGit(cwd: string, ...args: string[]) {
  return await execFileAsync("git", args, { cwd });
}

function runWorkerProcess(options: {
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
}> {
  return new Promise((resolveResult, reject) => {
    const child = spawn("node", ["packages/worker/dist/index.js"], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      resolveResult({ exitCode, signal, stderr });
    });
  });
}

async function createTurnLeaseServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    if (
      request.method === "POST" &&
      request.url === "/api/v1/worker-turn-lease"
    ) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          acquired: true,
          expiresAt: "2026-04-26T01:00:00.000Z",
        })
      );
      return;
    }
    if (request.method === "POST" && request.url === "/api/v1/tracker-state") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ok: true,
          outcome: "confirmed",
          state: "In progress",
          routable: true,
          routableReason: null,
        })
      );
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectServer);
      resolveServer();
    });
  });
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolveServer, rejectServer) => {
        server.close((error) =>
          error ? rejectServer(error) : resolveServer()
        );
      }),
  };
}

function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function chmodExecutable(path: string) {
  const { chmod } = await import("node:fs/promises");
  await chmod(path, 0o755);
}
