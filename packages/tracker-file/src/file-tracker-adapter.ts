import { readFile, writeFile } from "node:fs/promises";
import type {
  OrchestratorTrackerAdapter,
  OrchestratorProjectConfig,
  OrchestratorRunRecord,
  TrackedIssue,
  TrackerCommentWriteResult,
  TrackerStateRequest,
  TrackerStateResult,
} from "@gh-symphony/core";
import { filterIssuesByPickupLabels } from "@gh-symphony/core";

function requireTrackerSetting(
  project: OrchestratorProjectConfig,
  key: string
): string {
  const value = project.tracker.settings?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Tracker adapter "file" requires the "${key}" setting.`);
  }
  return value;
}

function parseIssueNumber(identifier: string): number {
  const match = identifier.match(/#(\d+)$/);
  return match ? Number.parseInt(match[1] ?? "0", 10) : 0;
}

function isValidIssueShape(entry: unknown): entry is TrackedIssue {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.identifier === "string" &&
    typeof e.state === "string" &&
    (e.dispatchable === undefined || typeof e.dispatchable === "boolean") &&
    e.repository !== null &&
    typeof e.repository === "object" &&
    e.tracker !== null &&
    typeof e.tracker === "object"
  );
}

function normalizeIssueDefaults(entry: Record<string, unknown>): TrackedIssue {
  return {
    ...entry,
    dispatchable: entry.dispatchable === undefined ? true : entry.dispatchable,
    assigneeId: typeof entry.assigneeId === "string" ? entry.assigneeId : null,
  } as TrackedIssue;
}

async function readIssueEntries(
  issuesPath: string
): Promise<Record<string, unknown>[]> {
  const raw = await readFile(issuesPath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(
      `Expected an array of issues in ${issuesPath}, got ${typeof parsed}`
    );
  }
  return parsed.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)
  );
}

async function writeIssueEntries(
  issuesPath: string,
  entries: readonly Record<string, unknown>[]
): Promise<void> {
  await writeFile(issuesPath, `${JSON.stringify(entries, null, 2)}\n`);
}

async function readValidIssues(
  project: OrchestratorProjectConfig
): Promise<TrackedIssue[]> {
  const issuesPath = requireTrackerSetting(project, "issuesPath");
  try {
    const entries = await readIssueEntries(issuesPath);
    const valid: TrackedIssue[] = [];
    for (let i = 0; i < entries.length; i++) {
      if (isValidIssueShape(entries[i])) {
        valid.push(normalizeIssueDefaults(entries[i]));
      } else {
        process.stderr.write(
          `[tracker-file] Skipping invalid issue at index ${i} in ${issuesPath}\n`
        );
      }
    }
    return valid;
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return [];
    }
    if (err instanceof SyntaxError) {
      throw new Error(
        `[tracker-file] Failed to parse issues JSON at ${issuesPath}: ${err.message}`,
        { cause: err }
      );
    }
    throw err;
  }
}

function buildTrackerStateResult(
  request: TrackerStateRequest,
  result: Pick<TrackerStateResult, "ok" | "outcome" | "state" | "error">
): TrackerStateResult {
  return {
    ok: result.ok,
    outcome: result.outcome,
    state: result.state,
    expectedState:
      request.type === "transition-request" ? request.expectedState : null,
    targetState:
      request.type === "transition-request" ? request.targetState : null,
    reason: request.type === "transition-request" ? request.reason : null,
    rateLimits: null,
    error: result.error,
  };
}

export const fileTrackerAdapter: OrchestratorTrackerAdapter = {
  async listIssues(project) {
    return filterIssuesByPickupLabels(await readValidIssues(project), project);
  },

  async listIssuesByStates(project, states) {
    if (states.length === 0) {
      return [];
    }

    const issues = await readValidIssues(project);
    const normalizedStates = new Set(
      states.map((state) => state.trim().toLowerCase())
    );
    return issues.filter((issue) =>
      normalizedStates.has(issue.state.trim().toLowerCase())
    );
  },

  async fetchIssueStatesByIds(project, issueIds) {
    if (issueIds.length === 0) {
      return [];
    }

    const issues = await readValidIssues(project);
    const ids = new Set(issueIds);
    return issues.filter((issue) => ids.has(issue.id));
  },

  getTrackerItemId(issue) {
    const itemId = issue.nativeRef?.itemId;
    return typeof itemId === "string" ? itemId : null;
  },

  resolveTerminalFact(issue) {
    const terminalFact = issue.metadata.terminalFact;
    if (!terminalFact || typeof terminalFact !== "object") {
      return null;
    }
    const fact = terminalFact as Record<string, unknown>;
    return typeof fact.kind === "string" && typeof fact.reason === "string"
      ? {
          kind: fact.kind,
          reason: fact.reason,
          relatedIdentifier:
            typeof fact.relatedIdentifier === "string"
              ? fact.relatedIdentifier
              : null,
        }
      : null;
  },

  async requestState(project, input): Promise<TrackerStateResult> {
    const issuesPath = requireTrackerSetting(project, "issuesPath");
    let entries: Record<string, unknown>[];
    try {
      entries = await readIssueEntries(issuesPath);
    } catch (error) {
      return buildTrackerStateResult(input.request, {
        ok: false,
        outcome: "failed",
        state: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const entry = entries.find(
      (candidate) => candidate.id === input.issueSubjectId
    );
    if (!entry || typeof entry.state !== "string") {
      return buildTrackerStateResult(input.request, {
        ok: false,
        outcome: "failed",
        state: null,
        error: "file_tracker_issue_not_found",
      });
    }

    if (input.request.type === "state-read") {
      return buildTrackerStateResult(input.request, {
        ok: true,
        outcome: "confirmed",
        state: entry.state,
        error: null,
      });
    }

    if (
      entry.state.trim().toLowerCase() !==
      input.request.expectedState.trim().toLowerCase()
    ) {
      return buildTrackerStateResult(input.request, {
        ok: false,
        outcome: "expected_state_mismatch",
        state: entry.state,
        error: "expected_state_mismatch",
      });
    }

    entry.state = input.request.targetState;
    await writeIssueEntries(issuesPath, entries);
    return buildTrackerStateResult(input.request, {
      ok: true,
      outcome: "confirmed",
      state: input.request.targetState,
      error: null,
    });
  },

  async upsertTransitionComment(
    project,
    input
  ): Promise<TrackerCommentWriteResult> {
    const issuesPath = requireTrackerSetting(project, "issuesPath");
    const entries = await readIssueEntries(issuesPath);
    const entry = entries.find(
      (candidate) => candidate.id === input.issueSubjectId
    );
    if (!entry) {
      throw new Error("file_tracker_issue_not_found");
    }

    const metadata =
      entry.metadata &&
      typeof entry.metadata === "object" &&
      !Array.isArray(entry.metadata)
        ? (entry.metadata as Record<string, unknown>)
        : {};
    const comments = Array.isArray(metadata.transitionComments)
      ? metadata.transitionComments.filter(
          (comment): comment is string => typeof comment === "string"
        )
      : [];
    if (comments.includes(input.body)) {
      return { outcome: "unchanged", rateLimits: null };
    }

    metadata.transitionComments = [...comments, input.body];
    entry.metadata = metadata;
    await writeIssueEntries(issuesPath, entries);
    return { outcome: "created", rateLimits: null };
  },

  buildWorkerEnvironment(_project, _issue) {
    return {
      SYMPHONY_FILE_TRACKER: "true",
    };
  },

  reviveIssue(project, run: OrchestratorRunRecord): TrackedIssue {
    return {
      id: run.issueId,
      identifier: run.issueIdentifier,
      number: parseIssueNumber(run.issueIdentifier),
      title: run.issueTitle ?? run.issueIdentifier,
      description: null,
      priority: null,
      state: run.issueState,
      branchName: null,
      url: null,
      labels: [],
      dispatchable: true,
      assigneeId: null,
      blockedBy: [],
      createdAt: null,
      updatedAt: null,
      repository: run.repository,
      tracker: {
        adapter: "file",
        bindingId: project.tracker.bindingId,
      },
      nativeRef: { itemId: run.issueId },
      metadata: {},
    };
  },
};
