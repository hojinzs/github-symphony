import { describe, expect, it } from "vitest";
import { renderContinuationGuidance } from "./render.js";

describe("renderContinuationGuidance", () => {
  it("renders supported continuation variables", () => {
    expect(
      renderContinuationGuidance(
        "Continue after {{ cumulativeTurnCount }} turns. Summary: {{ lastTurnSummary }}",
        {
          cumulativeTurnCount: "3",
          lastTurnSummary: "Validated the workflow prompt.",
        }
      )
    ).toBe(
      "Continue after 3 turns. Summary: Validated the workflow prompt."
    );
  });

  it("rejects Liquid tags", () => {
    expect(() =>
      renderContinuationGuidance("{% if cumulativeTurnCount %}resume{% endif %}", {
        cumulativeTurnCount: "3",
        lastTurnSummary: "Validated the workflow prompt.",
      })
    ).toThrow("continuation guidance does not support Liquid tags");
  });

  it("rejects unsupported variables", () => {
    expect(() =>
      renderContinuationGuidance("Issue {{ issue.title }}", {
        cumulativeTurnCount: "3",
        lastTurnSummary: "Validated the workflow prompt.",
      })
    ).toThrow("unsupported continuation guidance variable 'issue.title'");
  });
});
