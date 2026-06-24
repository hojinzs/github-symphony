import { describe, expect, it } from "vitest";
import { formatErrorForTerminal, hasVerboseFlag } from "./error-format.js";

describe("terminal error formatting", () => {
  it("keeps non-verbose errors to a single message line", () => {
    const error = new Error("top-level failure", {
      cause: new Error("root cause"),
    });

    expect(formatErrorForTerminal(error)).toBe("top-level failure\n");
  });

  it("prints stacks and walks causes when verbose", () => {
    const cause = new Error("root cause");
    cause.stack = "Error: root cause\n    at root";
    const error = new Error("top-level failure", { cause });
    error.stack = "Error: top-level failure\n    at top";

    expect(formatErrorForTerminal(error, { verbose: true })).toBe(
      [
        "Error: top-level failure",
        "    at top",
        "Caused by: Error: root cause",
        "    at root",
        "",
      ].join("\n")
    );
  });

  it("detects circular cause chains before repeating the top-level error", () => {
    const cause = new Error("root cause");
    cause.stack = "Error: root cause\n    at root";
    const error = new Error("top-level failure", { cause });
    error.stack = "Error: top-level failure\n    at top";
    cause.cause = error;

    expect(formatErrorForTerminal(error, { verbose: true })).toBe(
      [
        "Error: top-level failure",
        "    at top",
        "Caused by: Error: root cause",
        "    at root",
        "Caused by: [Circular cause]",
        "",
      ].join("\n")
    );
  });

  it("detects both verbose flags", () => {
    expect(hasVerboseFlag(["repo", "start", "--verbose"])).toBe(true);
    expect(hasVerboseFlag(["-v", "repo", "start"])).toBe(true);
    expect(hasVerboseFlag(["repo", "start"])).toBe(false);
  });
});
