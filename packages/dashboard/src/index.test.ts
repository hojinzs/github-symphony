import { describe, expect, it, vi } from "vitest";
import { runCli } from "./index.js";

const listen = vi.fn();
const once = vi.fn();
const address = vi.fn();

vi.mock("./server.js", () => ({
  startDashboardServer: vi.fn(() => ({
    listen,
    once,
    address,
  })),
}));

describe("runCli", () => {
  it("rejects a missing option value before startup", async () => {
    await expect(runCli(["--project-id", "--port", "4600"])).rejects.toThrow(
      "Option '--project-id' argument missing"
    );
  });

  it("rejects invalid project IDs before constructing filesystem paths", async () => {
    await expect(runCli(["--project-id", "../tenant-1"])).rejects.toThrow(
      'Invalid project ID "../tenant-1"'
    );
  });
});
