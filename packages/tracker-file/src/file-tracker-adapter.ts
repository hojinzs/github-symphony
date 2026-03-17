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
      return parsed as TrackedIssue[];
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
      title: run.issueIdentifier,
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
