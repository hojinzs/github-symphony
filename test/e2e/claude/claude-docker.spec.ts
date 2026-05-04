import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
      await appendRunEvents(
        runDirectory,
        result.args,
        newEvents
      );
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

function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

async function chmodExecutable(path: string) {
  const { chmod } = await import("node:fs/promises");
  await chmod(path, 0o755);
}
