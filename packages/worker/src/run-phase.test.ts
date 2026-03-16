import { describe, expect, it } from "vitest";
import { resolveExitRunPhase } from "./run-phase.js";

describe("resolveExitRunPhase", () => {
  it("marks successful exits as succeeded from non-terminal phases", () => {
    expect(
      resolveExitRunPhase("initializing_session", { code: 0, signal: null })
    ).toBe("succeeded");
  });

  it("marks failed exits as failed from non-terminal phases", () => {
    expect(
      resolveExitRunPhase("launching_agent", { code: 1, signal: null })
    ).toBe("failed");
  });

  it("preserves an existing terminal phase", () => {
    expect(
      resolveExitRunPhase("timed_out", { code: 1, signal: "SIGTERM" })
    ).toBe("timed_out");
  });
});
