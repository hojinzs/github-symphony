import { describe, expect, it } from "vitest";
import {
  resolveBudgetExceededReason,
  resolveSessionBudgetState,
} from "./session-budget.js";

describe("session budget helpers", () => {
  it("parses cumulative budget baselines and limits from env", () => {
    const budget = resolveSessionBudgetState({
      SYMPHONY_CUMULATIVE_TURN_COUNT: "3",
      SYMPHONY_CUMULATIVE_INPUT_TOKENS: "10",
      SYMPHONY_CUMULATIVE_OUTPUT_TOKENS: "5",
      SYMPHONY_CUMULATIVE_TOTAL_TOKENS: "15",
      SYMPHONY_SESSION_STARTED_AT: "2026-03-08T00:00:00.000Z",
      SYMPHONY_GLOBAL_MAX_TURNS: "9",
      SYMPHONY_MAX_TOKENS: "200",
      SYMPHONY_SESSION_TIMEOUT_MS: "60000",
    });

    expect(budget).toEqual({
      cumulativeTurnCount: 3,
      tokenUsageBaseline: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
      sessionStartedAt: "2026-03-08T00:00:00.000Z",
      globalMaxTurns: 9,
      maxTokens: 200,
      sessionTimeoutMs: 60000,
    });
  });

  it("flags global turn budgets before starting another turn", () => {
    const budget = resolveSessionBudgetState({
      SYMPHONY_CUMULATIVE_TURN_COUNT: "4",
      SYMPHONY_GLOBAL_MAX_TURNS: "4",
    });

    expect(
      resolveBudgetExceededReason(
        budget,
        0,
        { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        new Date("2026-03-08T00:00:00.000Z")
      )
    ).toBe("global-turns");
  });

  it("flags cumulative token budgets across worker sessions", () => {
    const budget = resolveSessionBudgetState({
      SYMPHONY_CUMULATIVE_TOTAL_TOKENS: "90",
      SYMPHONY_MAX_TOKENS: "100",
    });

    expect(
      resolveBudgetExceededReason(
        budget,
        0,
        { inputTokens: 0, outputTokens: 0, totalTokens: 10 },
        new Date("2026-03-08T00:00:00.000Z")
      )
    ).toBe("tokens");
  });

  it("flags session timeout budgets from the persisted session start", () => {
    const budget = resolveSessionBudgetState({
      SYMPHONY_SESSION_STARTED_AT: "2026-03-08T00:00:00.000Z",
      SYMPHONY_SESSION_TIMEOUT_MS: "1000",
    });

    expect(
      resolveBudgetExceededReason(
        budget,
        0,
        { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        new Date("2026-03-08T00:00:01.000Z")
      )
    ).toBe("session-timeout");
  });
});
