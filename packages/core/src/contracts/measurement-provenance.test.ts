import { expect, it } from "vitest";
import { isOrchestratorChannelEvent } from "./orchestrator-channel.js";

it("accepts legacy channel events and optional provenance but rejects malformed attribution", () => {
  const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const base = {
    issueId: "issue",
    startedAt: "now",
    threadId: null,
    turnId: null,
    turnCount: 1,
    sessionId: null,
  };
  const events = [
    {
      type: "codex_update",
      issueId: "issue",
      lastEventAt: "now",
      tokenUsage: usage,
    },
    {
      type: "heartbeat",
      issueId: "issue",
      lastEventAt: null,
      tokenUsage: usage,
      rateLimits: null,
      sessionInfo: null,
      executionPhase: null,
      runPhase: null,
      lastError: null,
    },
    {
      ...base,
      type: "turn_completed",
      completedAt: "now",
      durationMs: 0,
      tokenUsage: usage,
    },
    {
      ...base,
      type: "turn_failed",
      failedAt: "now",
      durationMs: 0,
      tokenUsage: usage,
      error: null,
    },
  ];
  for (const event of events) {
    expect(isOrchestratorChannelEvent(event)).toBe(true);
    for (const runtimeKind of ["codex-app-server", "claude-print", "custom"]) {
      for (const tokenUsageMeasured of [true, false, undefined]) {
        expect(
          isOrchestratorChannelEvent({
            ...event,
            runtimeKind,
            tokenUsageMeasured,
          })
        ).toBe(true);
      }
    }
    for (const provenance of [
      { runtimeKind: 123 },
      { runtimeKind: null },
      { runtimeKind: "unknown-model" },
      { tokenUsageMeasured: "true" },
      { tokenUsageMeasured: null },
    ]) {
      expect(isOrchestratorChannelEvent({ ...event, ...provenance })).toBe(
        false
      );
    }
  }
});
