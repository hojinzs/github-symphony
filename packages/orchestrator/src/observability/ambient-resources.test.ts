import { expect, it } from "vitest";
import { parseOtlpPolicy, resolveOtlpConfiguration } from "@gh-symphony/core";
import { createProjectResource } from "./resource.js";
import { createTelemetryLifecycle } from "./lifecycle.js";

const identity = {
  version: "test",
  instanceId: "owned",
  projectId: "p",
  projectSlug: "o/r",
  trackerKind: "file",
};
const policy = (attributes = {}) =>
  parseOtlpPolicy({
    otlp: {
      enabled: true,
      endpoint: "http://localhost:4318",
      resource_attributes: attributes,
    },
  });

it("keeps owned resource identity across ambient startup and reload", async () => {
  const initial = resolveOtlpConfiguration(policy(), {});
  const owner = await createTelemetryLifecycle(initial, {
    createPipeline: async () => ({ shutdown: async () => {} }),
  });
  for (const env of [
    { OTEL_SERVICE_NAME: "CANARY_AMBIENT" },
    { OTEL_RESOURCE_ATTRIBUTES: "service.instance.id=CANARY_AMBIENT" },
    { OTEL_RESOURCE_ATTRIBUTES: "symphony.run.id=CANARY_AMBIENT" },
    { OTEL_RESOURCE_ATTRIBUTES: "symphony.max_token=CANARY_AMBIENT" },
    { OTEL_RESOURCE_ATTRIBUTES: "a=CANARY_AMBIENT," },
    { OTEL_RESOURCE_ATTRIBUTES: "" },
    {
      OTEL_RESOURCE_ATTRIBUTES: Array.from(
        { length: 20 },
        (_, i) => `k8s.key${i}=safe`
      ).join(","),
    },
  ]) {
    const candidate = resolveOtlpConfiguration(policy(), env);
    const resource = createProjectResource({
      ...identity,
      attributes: candidate.resourceAttributes,
    });
    expect(resource.attributes["service.name"]).toBe("gh-symphony");
    expect(resource.attributes["service.instance.id"]).toBe("owned");
    owner.reload(candidate);
    const status = owner.status();
    expect(status.enabled).toBe(true);
    expect(
      (status.pending ?? status.applied).discardedEnvironmentResources?.length
    ).toBeGreaterThan(0);
    expect(JSON.stringify(status)).not.toContain("CANARY_AMBIENT");
  }
  const pending = (key: string) =>
    resolveOtlpConfiguration(policy(), {
      OTEL_RESOURCE_ATTRIBUTES: `region=east,${key}=CANARY_AMBIENT`,
    });
  owner.reload(pending("service.name"));
  owner.reload(pending("service.instance.id"));
  expect(owner.status().pending?.discardedEnvironmentResources).toEqual([
    { key: "service.instance.id", reason: "reserved identity" },
  ]);
  await owner.shutdown();
});
