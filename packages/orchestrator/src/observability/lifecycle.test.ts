import { afterEach, describe, expect, it, vi } from "vitest";
import { parseOtlpPolicy, resolveOtlpConfiguration } from "@gh-symphony/core";
import { createTelemetryLifecycle } from "./lifecycle.js";

function config(enabled = true, secret = "Bearer private-startup") {
  return resolveOtlpConfiguration(
    parseOtlpPolicy({
      otlp: {
        enabled,
        endpoint: "https://collector.example",
        headers: { Authorization: "$AUTH" },
      },
    }),
    { AUTH: secret }
  );
}

afterEach(() => vi.useRealTimers());

describe("OTLP lifecycle", () => {
  it("OT-03: disabled startup constructs nothing; production enable defaults off", async () => {
    vi.useFakeTimers();
    const createPipeline = vi.fn();
    const owner = await createTelemetryLifecycle(config(false), {
      createPipeline,
    });
    expect(vi.getTimerCount()).toBe(0);
    owner.publication.offerSnapshot?.({} as never);
    await owner.shutdown();
    expect(createPipeline).not.toHaveBeenCalled();
    expect(owner.status()).toMatchObject({
      enabled: false,
      state: "disabled",
      restartRequired: false,
    });
    await expect(createTelemetryLifecycle(config())).rejects.toThrow(
      "unsupported"
    );
  });

  it("OT-10: immutable startup, pending disable, duplicate suppression and revert", async () => {
    const original = config();
    const shutdown = vi.fn(async () => {});
    const offerSnapshot = vi.fn();
    const createPipeline = vi.fn(
      async (_applied: Readonly<ReturnType<typeof config>>) => ({
        shutdown,
        offerSnapshot,
      })
    );
    const warning = vi.fn();
    const owner = await createTelemetryLifecycle(original, {
      createPipeline,
      warning,
    });
    original.logs!.headers.Authorization = "mutated";
    expect(createPipeline.mock.calls[0]![0].logs!.headers.Authorization).toBe(
      "Bearer private-startup"
    );
    expect(
      Object.isFrozen(createPipeline.mock.calls[0]![0].logs!.headers)
    ).toBe(true);
    owner.reload(config(false));
    owner.reload(config(false));
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("remains active")
    );
    expect(owner.status()).toMatchObject({
      enabled: true,
      applied: { enabled: true },
      pending: { enabled: false },
      restartRequired: true,
    });
    owner.publication.offerSnapshot?.({} as never);
    expect(offerSnapshot).toHaveBeenCalledTimes(1);
    expect(createPipeline).toHaveBeenCalledTimes(1);
    owner.reload(config());
    expect(owner.status()).toMatchObject({
      pending: null,
      restartRequired: false,
    });
    await owner.shutdown();
  });

  it("OT-12: secret rotation is pending without exposing secrets or mutating descriptors", async () => {
    const owner = await createTelemetryLifecycle(config(), {
      createPipeline: async () => ({ shutdown: async () => {} }),
    });
    owner.reload(config(true, "Bearer private-rotated"));
    expect(owner.status().restartRequired).toBe(true);
    expect(JSON.stringify(owner.status())).not.toContain("private");
    const status = owner.status();
    status.applied.signals.logs!.headerNames.push("forged");
    expect(owner.status().applied.signals.logs!.headerNames).toEqual([
      "Authorization",
    ]);
    await owner.shutdown();
  });

  it("OT-11: shutdown shares one deadline, contains failures and stops offers", async () => {
    vi.useFakeTimers();
    const offerSnapshot = vi.fn();
    const shutdown = vi.fn(() => new Promise<void>(() => {}));
    const owner = await createTelemetryLifecycle(config(), {
      createPipeline: async () => ({ shutdown, offerSnapshot }),
    });
    const started = Date.now();
    const closing = owner.shutdown();
    expect(owner.shutdown()).toBe(closing);
    owner.publication.offerSnapshot?.({} as never);
    expect(offerSnapshot).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    await closing;
    expect(shutdown).toHaveBeenCalledExactlyOnceWith(started + 5000);
    expect(vi.getTimerCount()).toBe(0);
    const failing = await createTelemetryLifecycle(config(), {
      createPipeline: async () => ({
        shutdown: async () => {
          throw new Error("Bearer private-error");
        },
      }),
    });
    await expect(failing.shutdown()).resolves.toBeUndefined();
    expect(failing.status().state).toBe("degraded");
    expect(JSON.stringify(failing.status())).not.toContain("private-error");
  });
});
