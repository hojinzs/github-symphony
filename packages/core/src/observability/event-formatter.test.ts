import { describe, expect, it } from "vitest";
import {
  formatEventMessage,
  parseRecentEvents,
  parseRunEventLine,
} from "./event-formatter.js";

describe("event-formatter", () => {
  it("formats supported orchestrator events", () => {
    expect(
      formatEventMessage({
        at: "2026-03-16T00:00:00.000Z",
        event: "run-dispatched",
        projectId: "project-1",
        issueIdentifier: "acme/repo#1",
        issueState: "Todo",
      })
    ).toBe("Dispatched from Todo");

    expect(
      formatEventMessage({
        at: "2026-03-16T00:01:00.000Z",
        event: "workspace-cleanup",
        workspaceKey: "workspace-1",
        issueIdentifier: "acme/repo#1",
        outcome: "removed",
      })
    ).toBe("removed");

    expect(
      formatEventMessage({
        at: "2026-03-16T00:02:00.000Z",
        event: "workspace-cleanup",
        workspaceKey: "workspace-2",
        issueIdentifier: "acme/repo#1",
        outcome: "skipped",
        error: "cleanup failed",
      })
    ).toBe("skipped: cleanup failed");

    expect(
      formatEventMessage({
        at: "2026-03-16T00:03:00.000Z",
        event: "turn-started",
        issueIdentifier: "acme/repo#1",
        turnCount: 2,
      })
    ).toBe("Turn 2 started");

    expect(
      formatEventMessage({
        at: "2026-03-16T00:04:00.000Z",
        event: "turn-completed",
        issueIdentifier: "acme/repo#1",
        turnCount: 2,
        startedAt: "2026-03-16T00:03:00.000Z",
        durationMs: 1234,
        tokenUsage: {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        },
      })
    ).toBe("Turn 2 completed in 1234ms");

    expect(
      formatEventMessage({
        at: "2026-03-16T00:05:00.000Z",
        event: "turn-failed",
        issueIdentifier: "acme/repo#1",
        turnCount: 2,
        startedAt: "2026-03-16T00:03:00.000Z",
        durationMs: 2345,
        tokenUsage: {
          inputTokens: 12,
          outputTokens: 6,
          totalTokens: 18,
        },
        error: "tool execution failed",
      })
    ).toBe("tool execution failed");
  });

  it("formats run-recovered events", () => {
    expect(
      formatEventMessage({
        at: "2026-03-16T00:01:00.000Z",
        event: "run-recovered",
        issueIdentifier: "acme/repo#1",
      })
    ).toBe("Recovered existing run");
  });

  it("parses recent events while skipping partial and invalid lines", () => {
    const raw = [
      '{"partial":true',
      JSON.stringify({
        at: "2026-03-16T00:00:00.000Z",
        event: "run-dispatched",
        projectId: "project-1",
        issueIdentifier: "acme/repo#1",
        issueState: "Todo",
      }),
      '{"bad":',
      JSON.stringify({
        at: "2026-03-16T00:01:00.000Z",
        event: "worker-error",
        runId: "run-1",
        issueIdentifier: "acme/repo#1",
        error: "worker failed",
        attempt: 1,
      }),
      "",
    ].join("\n");

    expect(
      parseRecentEvents(raw, 2, {
        allowPartialFirstLine: true,
      })
    ).toEqual([
      {
        at: "2026-03-16T00:00:00.000Z",
        event: "run-dispatched",
        message: "Dispatched from Todo",
      },
      {
        at: "2026-03-16T00:01:00.000Z",
        event: "worker-error",
        message: "worker failed",
      },
    ]);
  });

  it("returns null when an NDJSON line cannot be parsed", () => {
    expect(parseRunEventLine('{"bad":')).toBeNull();
  });
});
