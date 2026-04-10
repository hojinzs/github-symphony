import { Theme } from "@radix-ui/themes";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IssueStatusEvent, IssueStatusSnapshot } from "@gh-symphony/core";
import {
  IssueDetailView,
  classifyEventTone,
  formatAttemptSummary,
  mapStatusVariant,
} from "./routes/issues/$identifier.js";

const NOW = new Date("2026-04-10T12:00:00.000Z").valueOf();

function createDetail(
  overrides: Partial<IssueStatusSnapshot> = {}
): IssueStatusSnapshot {
  return {
    issue_identifier: "gh-symphony#174",
    issue_id: "issue-174",
    status: "running",
    workspace: {
      path: "/workspace/gh-symphony-174",
    },
    attempts: {
      restart_count: 1,
      current_retry_attempt: 2,
    },
    running: {
      session_id: "sess_a8f3c2d9e1b04f7a",
      turn_count: 14,
      state: "running",
      started_at: "2026-04-08T07:13:36.000Z",
      last_event: "worker_started",
      last_message: "Worker started (attempt 2)",
      last_event_at: "2026-04-10T11:59:28.000Z",
      tokens: {
        input_tokens: 42381,
        output_tokens: 8914,
        total_tokens: 51295,
        cumulative_input_tokens: 70100,
        cumulative_output_tokens: 38372,
        cumulative_total_tokens: 108472,
      },
    },
    retry: null,
    logs: {
      codex_session_logs: [],
    },
    recent_events: [
      {
        at: "2026-04-10T11:55:51.000Z",
        event: "run-retried",
        message: "Detected convergence state — re-entering implementation",
      },
      {
        at: "2026-04-10T11:59:30.000Z",
        event: "turn_started",
        message: "Worker started (attempt 2)",
      },
    ],
    last_error: null,
    tracked: {
      execution_phase: "implementation",
      run_phase: "active",
    },
    ...overrides,
  };
}

function renderIssueDetailView(
  props: Parameters<typeof IssueDetailView>[0]
) {
  return renderToStaticMarkup(
    <Theme appearance="dark" accentColor="blue" grayColor="gray" radius="medium">
      <IssueDetailView {...props} />
    </Theme>
  );
}

describe("issue detail helpers", () => {
  it("maps runtime statuses onto badge variants", () => {
    expect(mapStatusVariant("running")).toBe("running");
    expect(mapStatusVariant("retrying")).toBe("retry");
    expect(mapStatusVariant("failed")).toBe("failed");
    expect(mapStatusVariant("completed")).toBe("completed");
    expect(mapStatusVariant("unknown")).toBe("idle");
  });

  it("formats attempt summary with restart count", () => {
    expect(formatAttemptSummary(createDetail())).toBe("Attempt 2 · 1 restart");
    expect(
      formatAttemptSummary(
        createDetail({
          attempts: {
            restart_count: 2,
            current_retry_attempt: 3,
          },
        })
      )
    ).toBe("Attempt 3 · 2 restarts");
  });

  it("classifies recent events by freshness and message intent", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const successEvent: IssueStatusEvent = {
      at: "2026-04-10T11:59:58.000Z",
      event: "turn_started",
      message: "Worker started (attempt 2)",
    };
    const warningEvent: IssueStatusEvent = {
      at: "2026-04-10T11:59:40.000Z",
      event: "run-retried",
      message: "Detected convergence state — re-entering implementation",
    };
    const oldEvent: IssueStatusEvent = {
      at: "2026-04-10T11:40:00.000Z",
      event: "run-dispatched",
      message: "Lease acquired",
    };

    expect(classifyEventTone(successEvent)).toBe("success");
    expect(classifyEventTone(warningEvent)).toBe("warning");
    expect(classifyEventTone(oldEvent)).toBe("muted");
  });
});

describe("IssueDetailView", () => {
  it("renders issue detail cards and recent event list", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const markup = renderIssueDetailView({
      detail: createDetail(),
      error: null,
      isRefreshing: false,
      lastUpdatedAt: NOW,
      onRefresh: () => {},
    });

    expect(markup).toContain("gh-symphony#174");
    expect(markup).toContain("Attempt 2 · 1 restart");
    expect(markup).toContain("sess_a8f3c2d9e1b04f7a");
    expect(markup).toContain("/workspace/gh-symphony-174");
    expect(markup).toContain("108,472 (across 2 runs)");
    expect(markup).toContain("Worker started (attempt 2)");
    expect(markup).toContain("Detected convergence state");
  });

  it("renders stale-data warning when the query errors after a successful fetch", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const markup = renderIssueDetailView({
      detail: createDetail(),
      error: new Error("network down"),
      isRefreshing: false,
      lastUpdatedAt: NOW,
      onRefresh: () => {},
    });

    expect(markup).toContain("Showing stale data due to a network error");
    expect(markup).toContain("Last updated:");
  });
});

afterEach(() => {
  vi.useRealTimers();
});
