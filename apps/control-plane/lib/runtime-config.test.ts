import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOCKER_RUNTIME_URL,
  DEFAULT_LOCAL_RUNTIME_URL,
  resolveControlPlaneRuntimeUrl,
  resolveRuntimeDriver
} from "./runtime-config";

describe("resolveRuntimeDriver", () => {
  it("defaults to docker when no runtime driver is configured", () => {
    expect(resolveRuntimeDriver({})).toBe("docker");
  });

  it("accepts the local runtime driver", () => {
    expect(
      resolveRuntimeDriver({
        SYMPHONY_RUNTIME_DRIVER: "local"
      })
    ).toBe("local");
  });
});

describe("resolveControlPlaneRuntimeUrl", () => {
  it("uses a driver-aware fallback when no explicit runtime URL is configured", () => {
    expect(
      resolveControlPlaneRuntimeUrl({
        SYMPHONY_RUNTIME_DRIVER: "docker"
      })
    ).toBe(DEFAULT_DOCKER_RUNTIME_URL);
    expect(
      resolveControlPlaneRuntimeUrl({
        SYMPHONY_RUNTIME_DRIVER: "local"
      })
    ).toBe(DEFAULT_LOCAL_RUNTIME_URL);
  });
});
