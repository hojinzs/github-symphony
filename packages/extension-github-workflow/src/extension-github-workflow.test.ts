import { describe, expect, it } from "vitest";
import { verifyHandoff, suggestHandoffRepair } from "./handoff-verification.js";
import { createIntervention } from "./operator-actions.js";

describe("verifyHandoff", () => {
  it("returns verified when no transition was expected", () => {
    const result = verifyHandoff({
      runId: "run-1",
      issueIdentifier: "acme/platform#1",
      issueState: "Todo",
      expectedTransition: null,
      actualState: "Todo",
    });

    expect(result.verified).toBe(true);
    expect(result.error).toBeNull();
  });

  it("returns verified when actual state matches expected", () => {
    const result = verifyHandoff({
      runId: "run-1",
      issueIdentifier: "acme/platform#1",
      issueState: "Todo",
      expectedTransition: "Plan Review",
      actualState: "Plan Review",
    });

    expect(result.verified).toBe(true);
    expect(result.error).toBeNull();
  });

  it("returns failure when states do not match", () => {
    const result = verifyHandoff({
      runId: "run-1",
      issueIdentifier: "acme/platform#1",
      issueState: "Todo",
      expectedTransition: "Plan Review",
      actualState: "Todo",
    });

    expect(result.verified).toBe(false);
    expect(result.error).toContain("Plan Review");
    expect(result.error).toContain("Todo");
  });

  it("returns failure when actual state is unknown", () => {
    const result = verifyHandoff({
      runId: "run-1",
      issueIdentifier: "acme/platform#1",
      issueState: "Todo",
      expectedTransition: "Plan Review",
      actualState: null,
    });

    expect(result.verified).toBe(false);
    expect(result.error).toContain("unknown");
  });
});

describe("suggestHandoffRepair", () => {
  it("suggests no repair for verified handoffs", () => {
    const repair = suggestHandoffRepair({
      verified: true,
      runId: "run-1",
      issueIdentifier: "acme/platform#1",
      issueState: "Todo",
      expectedTransition: "Plan Review",
      actualState: "Plan Review",
      error: null,
    });

    expect(repair.kind).toBe("retry");
  });

  it("suggests force-transition when state is known but wrong", () => {
    const repair = suggestHandoffRepair({
      verified: false,
      runId: "run-1",
      issueIdentifier: "acme/platform#1",
      issueState: "Todo",
      expectedTransition: "Plan Review",
      actualState: "Todo",
      error: "mismatch",
    });

    expect(repair.kind).toBe("force-transition");
  });

  it("suggests operator-required when state is unknown", () => {
    const repair = suggestHandoffRepair({
      verified: false,
      runId: "run-1",
      issueIdentifier: "acme/platform#1",
      issueState: "Todo",
      expectedTransition: "Plan Review",
      actualState: null,
      error: "unknown state",
    });

    expect(repair.kind).toBe("operator-required");
  });
});

describe("createIntervention", () => {
  const now = new Date("2026-03-08T00:00:00.000Z");

  it("creates a typed intervention record", () => {
    const intervention = createIntervention("approval", {
      issueIdentifier: "acme/platform#1",
      tenantId: "ws-1",
      now,
    });

    expect(intervention.kind).toBe("approval");
    expect(intervention.issueIdentifier).toBe("acme/platform#1");
    expect(intervention.tenantId).toBe("ws-1");
    expect(intervention.createdAt).toBe("2026-03-08T00:00:00.000Z");
    expect(intervention.description).toContain("human review");
    expect(intervention.suggestedAction).toBeTruthy();
  });

  it("supports all intervention kinds", () => {
    const kinds = [
      "approval",
      "retry_exhausted",
      "handoff_repair",
      "cleanup_blocked",
      "cleanup_force_remove",
      "issue_closure_required",
      "transfer_rebind",
    ] as const;

    for (const kind of kinds) {
      const intervention = createIntervention(kind, {
        issueIdentifier: "acme/platform#1",
        tenantId: "ws-1",
        now,
      });

      expect(intervention.kind).toBe(kind);
      expect(intervention.description).toBeTruthy();
      expect(intervention.suggestedAction).toBeTruthy();
    }
  });
});
