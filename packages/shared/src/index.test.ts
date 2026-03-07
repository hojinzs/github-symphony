import { describe, expect, it } from "vitest";
import { WORKSPACE_STATUS_LABELS } from "./index";

describe("WORKSPACE_STATUS_LABELS", () => {
  it("exposes runtime labels for the control plane shell", () => {
    expect(WORKSPACE_STATUS_LABELS.running).toBe("Running");
  });
});
