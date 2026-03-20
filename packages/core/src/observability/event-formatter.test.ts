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
        outcome: "cleanup_blocked",
        error: "workspace locked",
      })
    ).toBe("cleanup_blocked: workspace locked");
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
