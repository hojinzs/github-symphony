import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./index.js";

type EventHandler = (...args: unknown[]) => void;

const serverState = {
  mode: "idle" as "idle" | "listening" | "error",
  error: new Error("listen failed"),
  address: {
    address: "127.0.0.1",
    family: "IPv4",
    port: 4680,
  } satisfies AddressInfo,
};

const listen = vi.fn();
const once = vi.fn<(event: string, handler: EventHandler) => object>();
const off = vi.fn<(event: string, handler: EventHandler) => object>();
const address = vi.fn();

vi.mock("./server.js", () => ({
  startDashboardServer: vi.fn(() => ({
    listen,
    once,
    off,
    address,
  })),
}));

describe("runCli", () => {
  beforeEach(() => {
    serverState.mode = "idle";
    serverState.error = new Error("listen failed");
    serverState.address = {
      address: "127.0.0.1",
      family: "IPv4",
      port: 4680,
    };
    listen.mockReset();
    once.mockReset();
    off.mockReset();
    address.mockReset();
    address.mockReturnValue(serverState.address);
    once.mockImplementation((event, handler) => {
      if (
        (event === "listening" && serverState.mode === "listening") ||
        (event === "error" && serverState.mode === "error")
      ) {
        queueMicrotask(() => {
          handler(serverState.error);
        });
      }

      return {
        listen,
        once,
        off,
        address,
      };
    });
    off.mockImplementation(() => ({
      listen,
      once,
      off,
      address,
    }));
  });

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

  it("rejects startup failures from server.listen()", async () => {
    serverState.mode = "error";
    serverState.error = Object.assign(new Error("listen EADDRINUSE"), {
      code: "EADDRINUSE",
    });

    await expect(runCli(["--project-id", "tenant-1"])).rejects.toThrow(
      "listen EADDRINUSE"
    );
  });

  it("prints the dashboard URL once the server is listening", async () => {
    serverState.mode = "listening";
    const stdout = { write: vi.fn() };

    await runCli(["--project-id", "tenant-1"], { stdout });

    expect(stdout.write).toHaveBeenCalledWith(
      "Dashboard server listening on http://127.0.0.1:4680\n"
    );
  });
});
