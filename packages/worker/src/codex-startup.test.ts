import { describe, expect, it, vi } from "vitest";
import { launchCodexWithValidatedPolicy } from "./codex-startup.js";

describe("launchCodexWithValidatedPolicy", () => {
  it("routes an invalid policy through controlled startup failure before launch", async () => {
    const launch = vi.fn();
    const onPolicyValidationFailure = vi.fn(async () => undefined);

    await expect(
      launchCodexWithValidatedPolicy(
        { SYMPHONY_APPROVAL_POLICY: "on-reqest" },
        launch,
        onPolicyValidationFailure
      )
    ).resolves.toBeNull();
    expect(onPolicyValidationFailure).toHaveBeenCalledWith(
      expect.stringContaining(
        "Codex policy validation failed: Invalid SYMPHONY_APPROVAL_POLICY"
      )
    );
    expect(launch).not.toHaveBeenCalled();
  });

  it("launches with typed policy settings after validation succeeds", async () => {
    const child = { pid: 42 };
    const launch = vi.fn(() => child);
    const onPolicyValidationFailure = vi.fn(async () => undefined);

    await expect(
      launchCodexWithValidatedPolicy(
        {
          SYMPHONY_APPROVAL_POLICY: "on-request",
          SYMPHONY_THREAD_SANDBOX: "workspace-write",
          SYMPHONY_TURN_SANDBOX_POLICY: "dangerFullAccess",
        },
        launch,
        onPolicyValidationFailure
      )
    ).resolves.toEqual({
      child,
      policySettings: {
        approvalPolicy: "on-request",
        threadSandbox: "workspace-write",
        turnSandboxPolicy: { type: "dangerFullAccess" },
      },
    });
    expect(launch).toHaveBeenCalledOnce();
    expect(onPolicyValidationFailure).not.toHaveBeenCalled();
  });
});
