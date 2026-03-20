import { readFile } from "node:fs/promises";
import type {
  OrchestratorTrackerAdapter,
  OrchestratorProjectConfig,
  OrchestratorRunRecord,
  TrackedIssue,
} from "@gh-symphony/core";

function requireTrackerSetting(
  project: OrchestratorProjectConfig,
  key: string,
): string {
  const value = project.tracker.settings?.[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `Tracker adapter "file" requires the "${key}" setting.`,
    );
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
    e.repository !== null &&
    typeof e.repository === "object" &&
    e.tracker !== null &&
    typeof e.tracker === "object"
  );
}

export const fileTrackerAdapter: OrchestratorTrackerAdapter = {
  async listIssues(project) {
    const issuesPath = requireTrackerSetting(project, "issuesPath");
    try {
      const raw = await readFile(issuesPath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error(
          `Expected an array of issues in ${issuesPath}, got ${typeof parsed}`,
        );
      }
      const valid: TrackedIssue[] = [];
      for (let i = 0; i < parsed.length; i++) {
        if (isValidIssueShape(parsed[i])) {
          valid.push(parsed[i]);
        } else {
          process.stderr.write(
            `[tracker-file] Skipping invalid issue at index ${i} in ${issuesPath}\n`,
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
      // Gracefully handle truncated/partial JSON from concurrent writes
      if (err instanceof SyntaxError) {
        return [];
      }
      throw err;
    }
  },

  async listIssuesByStates(project, states) {
    if (states.length === 0) {
      return [];
    }

    const issues = await this.listIssues(project);
    const normalizedStates = new Set(
      states.map((state) => state.trim().toLowerCase()),
    );
    return issues.filter((issue) =>
      normalizedStates.has(issue.state.trim().toLowerCase()),
    );
  },

  async fetchIssueStatesByIds(project, issueIds) {
    if (issueIds.length === 0) {
      return [];
    }

    const issues = await this.listIssues(project);
    const ids = new Set(issueIds);
    return issues.filter((issue) => ids.has(issue.id));
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
      state: "",
      branchName: null,
      url: null,
      labels: [],
      blockedBy: [],
      createdAt: null,
      updatedAt: null,
      repository: run.repository,
      tracker: {
        adapter: "file",
        bindingId: project.tracker.bindingId,
        itemId: run.issueId,
      },
      metadata: {},
    };
  },
};
