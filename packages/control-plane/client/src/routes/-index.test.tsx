import { describe, expect, it } from "vitest";
import {
  ActiveRunsTable,
  DataStatus,
  formatRelativeTime,
  mapRunStatusToBadgeVariant,
  RetryQueueTable,
  resolveRetryError,
} from "./index.js";
import { renderToStaticMarkup } from "react-dom/server";
import { Theme } from "@radix-ui/themes";

describe("Project overview helpers", () => {
  it("formats past timestamps as compact relative time", () => {
    expect(
      formatRelativeTime(
        "2026-04-10T05:00:00.000Z",
        new Date("2026-04-10T05:02:34.000Z")
      )
    ).toBe("2m 34s ago");
  });

  it("formats future timestamps for retry queue rows", () => {
    expect(
      formatRelativeTime(
        "2026-04-10T05:18:44.000Z",
        new Date("2026-04-10T05:00:00.000Z")
      )
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

  it("renders repository and tracker-side project identifiers", () => {
    const markup = renderToStaticMarkup(
      <Theme appearance="dark">
        <DataStatus
          projectState={{
            repository: {
              owner: "acme",
              name: "platform",
              cloneUrl: "https://github.com/acme/platform.git",
            },
            tracker: {
              adapter: "github",
              bindingId: "binding-1",
              settings: {
                projectId: "PVT_project_123",
              },
            },
            lastTickAt: "2026-04-10T05:00:00.000Z",
            health: "idle",
            summary: {
              dispatched: 0,
              suppressed: 0,
              recovered: 0,
              activeRuns: 0,
            },
            activeRuns: [],
            retryQueue: [],
            rateLimits: null,
            lastError: null,
            completedCount: 0,
            issues: [],
          }}
        />
      </Theme>
    );

    expect(markup).toContain("Repository acme/platform");
    expect(markup).toContain("Tracker binding-1");
    expect(markup).toContain("GitHub Project PVT_project_123");
    expect(markup).not.toContain("tenant-");
  });

  it("renders a repository fallback for legacy cached project state", () => {
    const markup = renderToStaticMarkup(
      <Theme appearance="dark">
        <DataStatus
          projectState={
            {
              tracker: {
                adapter: "github",
                bindingId: "binding-1",
              },
              lastTickAt: "2026-04-10T05:00:00.000Z",
              health: "idle",
              summary: {
                dispatched: 0,
                suppressed: 0,
                recovered: 0,
                activeRuns: 0,
              },
              activeRuns: [],
              retryQueue: [],
              rateLimits: null,
              lastError: null,
              completedCount: 0,
              issues: [],
            } as never
          }
        />
      </Theme>
    );

    expect(markup).toContain("Repository unavailable");
    expect(markup).toContain("Tracker binding-1");
  });

  it("renders tracker issue URLs for active and retrying rows", () => {
    const markup = renderToStaticMarkup(
      <Theme appearance="dark">
        <ActiveRunsTable
          projectState={
            {
              activeRuns: [
                {
                  runId: "run-1",
                  issueIdentifier: "acme/platform#42",
                  issueUrl: "https://github.com/acme/platform/issues/42",
                  issueState: "In progress",
                  status: "running",
                  retryKind: null,
                  port: null,
                },
              ],
            } as never
          }
        />
        <RetryQueueTable
          projectState={
            {
              retryQueue: [
                {
                  runId: "run-2",
                  issueIdentifier: "acme/platform#43",
                  issueUrl: "https://github.com/acme/platform/issues/43",
                  retryKind: "failure",
                  nextRetryAt: null,
                },
              ],
              issues: [],
            } as never
          }
        />
      </Theme>
    );

    expect(markup).toContain('href="https://github.com/acme/platform/issues/42"');
    expect(markup).toContain('href="https://github.com/acme/platform/issues/43"');
    expect(markup).toContain("acme/platform#42");
  });
});
