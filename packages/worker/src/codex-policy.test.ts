import { describe, expect, it } from "vitest";
import { resolveCodexPolicySettings } from "./codex-policy.js";

describe("resolveCodexPolicySettings", () => {
  it("rejects unknown approval and sandbox values with allowed values", () => {
    expect(() =>
      resolveCodexPolicySettings({ SYMPHONY_APPROVAL_POLICY: "on-reqest" })
    ).toThrow(
      'Invalid SYMPHONY_APPROVAL_POLICY value "on-reqest". Expected one of: never, on-failure, on-request, untrusted.'
    );

    expect(() =>
      resolveCodexPolicySettings({ SYMPHONY_THREAD_SANDBOX: "workpace-write" })
    ).toThrow(
      'Invalid SYMPHONY_THREAD_SANDBOX value "workpace-write". Expected one of: read-only, workspace-write, danger-full-access.'
    );

    expect(() =>
      resolveCodexPolicySettings({
        SYMPHONY_TURN_SANDBOX_POLICY: "danger-full-acess",
      })
    ).toThrow(
      'Invalid SYMPHONY_TURN_SANDBOX_POLICY value "danger-full-acess". Expected one of: read-only, workspace-write, danger-full-access.'
    );
  });

  it("accepts every supported policy value", () => {
    expect(
      resolveCodexPolicySettings({
        SYMPHONY_APPROVAL_POLICY: "on-request",
        SYMPHONY_THREAD_SANDBOX: "workspace-write",
        SYMPHONY_TURN_SANDBOX_POLICY: "read-only",
      })
    ).toEqual({
      approvalPolicy: "on-request",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: { type: "read-only" },
    });
  });

  it("retains the defaults when policy variables are unset or empty", () => {
    expect(resolveCodexPolicySettings({})).toEqual({
      approvalPolicy: "never",
      threadSandbox: "danger-full-access",
      turnSandboxPolicy: undefined,
    });

    expect(
      resolveCodexPolicySettings({
        SYMPHONY_APPROVAL_POLICY: "",
        SYMPHONY_THREAD_SANDBOX: "",
        SYMPHONY_TURN_SANDBOX_POLICY: "",
      })
    ).toEqual({
      approvalPolicy: "never",
      threadSandbox: "danger-full-access",
      turnSandboxPolicy: undefined,
    });
  });
});
