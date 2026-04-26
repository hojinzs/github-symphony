import { describe, expect, it } from "vitest";
import { classifyClaudeTurnExit } from "./exit-classifier.js";

describe("classifyClaudeTurnExit", () => {
  it("classifies exit 0 with success result as success", () => {
    expect(
      classifyClaudeTurnExit({
        exitCode: 0,
        signal: null,
        resultEvent: {
          type: "result",
          subtype: "success",
          stop_reason: "end_turn",
        },
      })
    ).toEqual({
      kind: "success",
      transient: false,
      reason: "result_success",
      resultStatus: "success",
    });
  });

  it("classifies exit 0 with error_* result as an application error", () => {
    expect(
      classifyClaudeTurnExit({
        exitCode: 0,
        signal: null,
        resultEvent: {
          type: "result",
          subtype: "error_max_turns",
          stop_reason: "error_max_turns",
        },
      })
    ).toEqual({
      kind: "app-error",
      transient: false,
      reason: "error_max_turns",
      resultStatus: "error_max_turns",
    });
  });

  it("marks rate-limit failures transient", () => {
    expect(
      classifyClaudeTurnExit({
        exitCode: 1,
        signal: null,
        resultEvent: {
          type: "result",
          subtype: "error_rate_limit",
          usage: {
            rate_limit: {
              limit: 100,
              remaining: 0,
              retry_after: 30,
            },
          },
        },
      })
    ).toMatchObject({
      kind: "process-error",
      transient: true,
    });
  });

  it("classifies non-zero exit with error wire event as transient when retryable", () => {
    expect(
      classifyClaudeTurnExit({
        exitCode: 1,
        signal: null,
        errorEvent: {
          type: "error",
          error: {
            type: "api_error",
            message: "temporarily unavailable",
          },
        },
      })
    ).toMatchObject({
      kind: "process-error",
      transient: true,
      reason: "exit_1",
    });
  });

  it("classifies SIGTERM as a transient process error", () => {
    expect(
      classifyClaudeTurnExit({
        exitCode: null,
        signal: "SIGTERM",
      })
    ).toEqual({
      kind: "process-error",
      transient: true,
      reason: "signal_SIGTERM",
      resultStatus: undefined,
    });
  });

  it("classifies SIGINT as a non-transient process error", () => {
    expect(
      classifyClaudeTurnExit({
        exitCode: null,
        signal: "SIGINT",
      })
    ).toEqual({
      kind: "process-error",
      transient: false,
      reason: "signal_SIGINT",
      resultStatus: undefined,
    });
  });
});
