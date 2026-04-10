import { describe, expect, it } from "vitest";
import {
  formatRelativeTime,
  mapRunStatusToBadgeVariant,
  resolveRetryError,
} from "./index.js";

describe("Project overview helpers", () => {
  it("formats past timestamps as compact relative time", () => {
    expect(
      formatRelativeTime("2026-04-10T05:00:00.000Z", new Date("2026-04-10T05:02:34.000Z"))
    ).toBe("2m 34s ago");
  });

  it("formats future timestamps for retry queue rows", () => {
    expect(
      formatRelativeTime("2026-04-10T05:18:44.000Z", new Date("2026-04-10T05:00:00.000Z"))
    ).toBe("in 18m 44s");
  });

  it("maps run statuses to dashboard badge variants", () => {
    expect(mapRunStatusToBadgeVariant("running")).toBe("running");
    expect(mapRunStatusToBadgeVariant("starting")).toBe("running");
    expect(mapRunStatusToBadgeVariant("retrying")).toBe("retry");
    expect(mapRunStatusToBadgeVariant("failed")).toBe("failed");
    expect(mapRunStatusToBadgeVariant("succeeded")).toBe("completed");
  });

  it("resolves retry errors from issue orchestration records", () => {
    expect(
      resolveRetryError(
        {
          issues: [
            {
              issueId: "issue-1",
              identifier: "gh-symphony#163",
              workspaceKey: "gh_symphony_163",
              completedOnce: false,
              failureRetryCount: 1,
              state: "released",
              currentRunId: "run-1",
              retryEntry: {
                attempt: 1,
                dueAt: "2026-04-10T05:18:44.000Z",
                error: "GitHub API rate limit exceeded",
              },
              updatedAt: "2026-04-10T05:00:00.000Z",
            },
          ],
        },
        "gh-symphony#163"
      )
    ).toBe("GitHub API rate limit exceeded");
  });
});
