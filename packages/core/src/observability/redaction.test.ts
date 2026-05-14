import { describe, expect, it } from "vitest";
import { redactObservabilitySecrets } from "./redaction.js";

describe("redactObservabilitySecrets", () => {
  it("redacts Linear API keys and Authorization headers recursively", () => {
    const redacted = redactObservabilitySecrets({
      event: "tool-call",
      LINEAR_API_KEY: "lin_secret",
      headers: {
        authorization: "Bearer lin_secret",
      },
      nested: [
        {
          token: "lin_secret",
          value: "safe",
        },
      ],
    });

    expect(redacted).toEqual({
      event: "tool-call",
      LINEAR_API_KEY: "[REDACTED]",
      headers: {
        authorization: "[REDACTED]",
      },
      nested: [
        {
          token: "[REDACTED]",
          value: "safe",
        },
      ],
    });
    expect(JSON.stringify(redacted)).not.toContain("lin_secret");
  });
});
