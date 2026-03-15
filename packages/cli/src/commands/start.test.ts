import { describe, expect, it, vi } from "vitest";

const startModule = await import("./start.js");

describe("shutdownForegroundOrchestrator", () => {
  it("exits even when removing the persisted status port fails", async () => {
    const close = vi.fn();
    const exit = vi.fn((code?: number) => {
      throw new Error(`exit:${code ?? "undefined"}`);
    }) as unknown as (code?: number) => never;
    const removePortFile = vi
      .fn<typeof import("node:fs/promises").rm>()
      .mockRejectedValue(new Error("permission denied"));

    await expect(
      startModule.shutdownForegroundOrchestrator({
        configDir: "/tmp/gh-symphony",
        projectId: "tenant-a",
        statusServer: { close },
        exit,
        removePortFile,
      })
    ).rejects.toThrow("exit:0");

    expect(close).toHaveBeenCalledTimes(1);
    expect(removePortFile).toHaveBeenCalledTimes(1);
  });
});
