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

  it("refuses an approval policy that could leave a request unanswered", async () => {
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
    ).resolves.toBeNull();
    expect(launch).not.toHaveBeenCalled();
    expect(onPolicyValidationFailure).toHaveBeenCalledWith(
      expect.stringContaining(
        'Invalid SYMPHONY_APPROVAL_POLICY value "on-request". Expected one of: never.'
      )
    );
  });
});
