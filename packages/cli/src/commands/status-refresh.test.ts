import { describe, expect, it, vi } from "vitest";
import {
  requestOrchestratorRefresh,
  resolveOrchestratorStatusBaseUrl,
} from "./status-refresh.js";

describe("resolveOrchestratorStatusBaseUrl", () => {
  it("uses the default localhost status API endpoint", () => {
    expect(resolveOrchestratorStatusBaseUrl({} as NodeJS.ProcessEnv)).toBe(
      "http://127.0.0.1:4680"
    );
  });

  it("formats IPv6 hosts correctly", () => {
    expect(
      resolveOrchestratorStatusBaseUrl({
        ORCHESTRATOR_STATUS_HOST: "::1",
        ORCHESTRATOR_STATUS_PORT: "7777",
      } as NodeJS.ProcessEnv)
    ).toBe("http://[::1]:7777");
  });
});

describe("requestOrchestratorRefresh", () => {
  it("posts to the refresh endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });

    await expect(
      requestOrchestratorRefresh({
        fetchImpl: fetchImpl as typeof fetch,
        env: {
          ORCHESTRATOR_STATUS_HOST: "127.0.0.1",
          ORCHESTRATOR_STATUS_PORT: "4680",
        } as NodeJS.ProcessEnv,
      })
    ).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:4680/api/v1/refresh",
      expect.objectContaining({
        method: "POST",
        signal: expect.any(AbortSignal),
      })
    );
  });

  it("uses the provided timeout when creating the abort signal", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");

    await requestOrchestratorRefresh({
      fetchImpl: fetchImpl as typeof fetch,
      timeoutMs: 1_500,
    });

    expect(timeoutSpy).toHaveBeenCalledWith(1_500);
  });

  it("swallows network failures and falls back to filesystem status", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));

    await expect(
      requestOrchestratorRefresh({
        fetchImpl: fetchImpl as typeof fetch,
      })
    ).resolves.toBe(false);
  });

  it("uses an explicit base URL when provided", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true });

    await expect(
      requestOrchestratorRefresh({
        fetchImpl: fetchImpl as typeof fetch,
        baseUrl: "http://127.0.0.1:9999",
      })
    ).resolves.toBe(true);

    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/api/v1/refresh",
      expect.objectContaining({
        method: "POST",
        signal: expect.any(AbortSignal),
      })
    );
  });
});
