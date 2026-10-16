import { expect, it, vi } from "vitest";

vi.mock("./status.js", () => {
  throw new Error("STATUS_COMMAND_INITIALIZED");
});

it("defers status command initialization until status is selected", async () => {
  await expect(import("./project.js")).resolves.toHaveProperty("default");
});
