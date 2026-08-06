import { describe, expect, it, vi } from "vitest";
import { launchCodexWithValidatedPolicy } from "./codex-startup.js";

describe("launchCodexWithValidatedPolicy", () => {
  it("rejects an invalid policy before launching the app-server", () => {
    const launch = vi.fn();

    expect(() =>
      launchCodexWithValidatedPolicy(
        { SYMPHONY_APPROVAL_POLICY: "on-reqest" },
        launch
      )
    ).toThrow(/Invalid SYMPHONY_APPROVAL_POLICY/);
    expect(launch).not.toHaveBeenCalled();
  });

  it("launches with typed policy settings after validation succeeds", () => {
    const child = { pid: 42 };
    const launch = vi.fn(() => child);

    expect(
      launchCodexWithValidatedPolicy(
        {
          SYMPHONY_APPROVAL_POLICY: "on-request",
          SYMPHONY_THREAD_SANDBOX: "workspace-write",
          SYMPHONY_TURN_SANDBOX_POLICY: "workspaceWrite",
        },
        launch
      )
    ).toEqual({
      child,
      policySettings: {
        approvalPolicy: "on-request",
        threadSandbox: "workspace-write",
        turnSandboxPolicy: { type: "workspaceWrite" },
      },
    });
    expect(launch).toHaveBeenCalledOnce();
  });
});
