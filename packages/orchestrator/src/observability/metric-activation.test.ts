import { expect, it, vi } from "vitest";
import { initializeMetrics } from "./activation.js";
const load = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Metrics SDK graph evaluated");
  })
);
vi.mock("./metric-pipeline.js", () => {
  load();
  return {};
});
it("disabled Metrics never evaluates the SDK graph even with explicit injection", async () => {
  expect(
    await initializeMetrics(false, {
      identity: {
        version: "test",
        projectId: "folder",
        projectSlug: "owner/repo",
        trackerKind: "file",
      },
      destination: { endpoint: "http://receiver/v1/metrics", headers: {} },
    })
  ).toBeUndefined();
  expect(load).not.toHaveBeenCalled();
});
it("production Metrics activation rejects before evaluating the SDK graph", async () => {
  await expect(initializeMetrics(true)).rejects.toThrow("unsupported");
  expect(load).not.toHaveBeenCalled();
});
