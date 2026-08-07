import { describe, expect, it } from "vitest";
import { resolveCodexPolicySettings } from "./codex-policy.js";

describe("resolveCodexPolicySettings", () => {
  it("rejects unknown approval and sandbox values with allowed values", () => {
    expect(() =>
      resolveCodexPolicySettings({ SYMPHONY_APPROVAL_POLICY: "on-reqest" })
    ).toThrow(
      'Invalid SYMPHONY_APPROVAL_POLICY value "on-reqest". Expected one of: never, on-request, on-failure, untrusted.'
    );

    expect(() =>
      resolveCodexPolicySettings({ SYMPHONY_THREAD_SANDBOX: "workpace-write" })
    ).toThrow(
      'Invalid SYMPHONY_THREAD_SANDBOX value "workpace-write". Expected one of: read-only, workspace-write, danger-full-access.'
    );

    expect(() =>
      resolveCodexPolicySettings({
        SYMPHONY_TURN_SANDBOX_POLICY: "dangerFullAcess",
      })
    ).toThrow(
      'Invalid SYMPHONY_TURN_SANDBOX_POLICY value "dangerFullAcess". Expected one of: dangerFullAccess, readOnly, externalSandbox, workspaceWrite.'
    );
  });

  it("accepts every supported policy value", () => {
    for (const approvalPolicy of [
      "never",
      "on-request",
      "on-failure",
      "untrusted",
    ]) {
      expect(
        resolveCodexPolicySettings({
          SYMPHONY_APPROVAL_POLICY: approvalPolicy,
        }).approvalPolicy
      ).toBe(approvalPolicy);
    }

    for (const threadSandbox of [
      "read-only",
      "workspace-write",
      "danger-full-access",
    ]) {
      expect(
        resolveCodexPolicySettings({
          SYMPHONY_THREAD_SANDBOX: threadSandbox,
        }).threadSandbox
      ).toBe(threadSandbox);
    }

    for (const turnSandboxPolicy of [
      "dangerFullAccess",
      "readOnly",
      "externalSandbox",
      "workspaceWrite",
    ]) {
      expect(
        resolveCodexPolicySettings({
          SYMPHONY_TURN_SANDBOX_POLICY: turnSandboxPolicy,
        }).turnSandboxPolicy
      ).toEqual({ type: turnSandboxPolicy });
    }
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
