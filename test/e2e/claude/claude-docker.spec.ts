import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createClaudePrintRuntimeAdapter } from "@gh-symphony/runtime-claude";
import type { AgentEvent } from "@gh-symphony/core";

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
const execFileAsync = promisify(execFile);

beforeAll(async () => {
  await chmodExecutable(stubPath);
  await chmodExecutable(stubWrapperPath);
});

afterEach(async () => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

describe("Claude Docker E2E with stub claude binary", () => {
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
    await runGit(workspace, "init", "-b", "feat/assigned");
    await runGit(workspace, "config", "user.name", "Symphony E2E");
    await runGit(workspace, "config", "user.email", "e2e@example.com");
    await runGit(workspace, "add", "WORKFLOW.md");
    await runGit(workspace, "commit", "-m", "test: seed Claude workspace");
    await runGit(workspace, "remote", "add", "origin", remote);
    await runGit(workspace, "push", "origin", "feat/assigned");
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

    const leaseServer = await createTurnLeaseServer();
    let result: Awaited<ReturnType<typeof runWorkerProcess>>;
    try {
      result = await runWorkerProcess({
        cwd: repoRoot,
        env: {
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
          TARGET_REPOSITORY_CLONE_URL: remote,
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
          SYMPHONY_CONTINUATION_GUIDANCE:
            "Continue with the same Claude session.",
          SYMPHONY_ORCHESTRATOR_URL: leaseServer.url,
          SYMPHONY_ORCHESTRATOR_TOKEN: "stub-orchestrator-token",
        },
      });
    } finally {
      await leaseServer.close();
    }

    expect(result.exitCode).toBe(0);
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
