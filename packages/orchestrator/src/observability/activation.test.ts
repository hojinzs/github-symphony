import { describe, expect, it, vi } from "vitest";
import { initializeLogs } from "./activation.js";
const load = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("SDK graph evaluated");
  })
);
vi.mock("./log-pipeline.js", () => {
  load();
  return {};
});
describe("production activation gate", () => {
  it("disabled initialization never evaluates the SDK graph", async () => {
    expect(await initializeLogs(false)).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });
  it("production enabled initialization rejects before SDK evaluation", async () => {
    await expect(initializeLogs(true)).rejects.toThrow("unsupported");
    expect(load).not.toHaveBeenCalled();
  });
});
