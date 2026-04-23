import { describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION_MAX_TURNS,
  resolveMaxTurns,
} from "./turn-limits.js";

describe("resolveMaxTurns", () => {
  it("falls back to the default when max_turns is missing or invalid", () => {
    expect(resolveMaxTurns(undefined)).toEqual({
      maxTurns: DEFAULT_SESSION_MAX_TURNS,
      exhaustedBeforeStart: false,
    });
    expect(resolveMaxTurns("not-a-number")).toEqual({
      maxTurns: DEFAULT_SESSION_MAX_TURNS,
      exhaustedBeforeStart: false,
    });
  });

  it("accepts positive integer-like max_turns values", () => {
    expect(resolveMaxTurns("3")).toEqual({
      maxTurns: 3,
      exhaustedBeforeStart: false,
    });
    expect(resolveMaxTurns(4.9)).toEqual({
      maxTurns: 4,
      exhaustedBeforeStart: false,
    });
  });

  it("treats zero or negative max_turns as exhausted before the first turn", () => {
    expect(resolveMaxTurns("0")).toEqual({
      maxTurns: 0,
      exhaustedBeforeStart: true,
    });
    expect(resolveMaxTurns("-2")).toEqual({
      maxTurns: 0,
      exhaustedBeforeStart: true,
    });
  });
});
