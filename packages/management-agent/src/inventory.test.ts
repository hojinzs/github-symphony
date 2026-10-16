import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  observationRequestSchema,
  type ProjectIdentity,
} from "@gh-symphony/management-protocol";
import { AgentRegistry, type LocalInventoryReader } from "./registry.js";
import { observationPages } from "./foreground.js";
import {
  createInventorySnapshot,
  type ProjectIdentityResolver,
} from "./inventory.js";
let root: string, registry: AgentRegistry;
const environmentId = randomUUID();
const reader: LocalInventoryReader = {
  async inspect() {
    const observedAt = new Date().toISOString();
    return {
      validation: {
        state: "invalid",
        diagnostic: { code: "project_invalid", message: "Workflow invalid" },
      },
      process: {
        state: "running",
        identity: "local-command-with-secret-canary",
        pid: 42,
        observedAt,
      },
      runs: [],
      metadata: {
        trackerScope: {
          adapter: "github",
          bindingId: "board",
          repository: "owner/repo",
          activeStates: ["Ready"],
          includeLabels: [],
          excludeLabels: [],
        },
      },
      credential: "do-not-upload",
    };
  },
};
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "c06-publisher-")));
  registry = await AgentRegistry.open(join(root, "agent"));
  await registry.saveIdentity("https://fleet.lan", {
    protocolVersion: 1,
    requestId: randomUUID(),
    environmentId,
    agentId: randomUUID(),
    credential: "fixture-only",
  });
  for (const name of ["a", "b"]) {
    await mkdir(join(root, name));
    await registry.add(join(root, name));
  }
});
afterEach(async () => {
  await registry.close();
  await rm(root, { recursive: true, force: true });
});
it("joins server identities by local ID and publishes only redacted fresh registry data", async () => {
  const identities = new Map(
    registry.list().map((p) => [p.localProjectId, randomUUID()])
  );
  const resolver: ProjectIdentityResolver = async (env, ids) =>
    ids
      .map((id) => ({
        environmentId: env,
        localProjectId: id,
        projectId: identities.get(id)!,
      }))
      .reverse();
  const snapshot = createInventorySnapshot({
    reader,
    cliVersion: "fixture",
    resolveIdentities: resolver,
  });
  const projects = await snapshot(registry, new AbortController().signal);
  expect(projects.map((p) => p.projectId)).toEqual(
    registry.list().map((p) => identities.get(p.localProjectId))
  );
  const pages = observationPages(
    {
      protocolVersion: 1,
      requestId: randomUUID(),
      environmentId,
      sessionId: randomUUID(),
    },
    projects,
    0
  );
  expect(
    observationRequestSchema.parse(pages[0]).inventory.projects[0]
  ).toMatchObject({
    validation: { state: "invalid" },
    process: { state: "running" },
    snapshot: { trackerScope: { bindingId: "board" } },
  });
  expect(JSON.stringify(pages)).not.toContain("do-not-upload");
  expect(JSON.stringify(pages)).not.toContain(
    "local-command-with-secret-canary"
  );
});
it("rejects missing, foreign, duplicate and malformed allocated identities", async () => {
  const ids = registry.list().map((p) => ({
    environmentId,
    localProjectId: p.localProjectId,
    projectId: randomUUID(),
  }));
  const invalid: ProjectIdentity[][] = [
    [],
    [ids[0]],
    [ids[0], ids[0]],
    [ids[0], { ...ids[1], environmentId: randomUUID() }],
    [ids[0], { ...ids[1], projectId: ids[0].projectId }],
    [ids[0], { ...ids[1], projectId: "not-uuid" }],
    [ids[0], { ...ids[1], localProjectId: "foreign" }],
  ];
  for (const response of invalid) {
    const snapshot = createInventorySnapshot({
      reader,
      cliVersion: "fixture",
      resolveIdentities: async () => response,
    });
    await expect(
      snapshot(registry, new AbortController().signal)
    ).rejects.toThrow("invalid_inventory_identity");
  }
});
it("resends current allowlist after resolver outage without replaying removed projects", async () => {
  let unavailable = false;
  const snapshot = createInventorySnapshot({
    reader,
    cliVersion: "fixture",
    resolveIdentities: async (env, ids) => {
      if (unavailable) throw new Error("fixture outage");
      return ids.map((id) => ({
        environmentId: env,
        localProjectId: id,
        projectId: randomUUID(),
      }));
    },
  });
  expect(await snapshot(registry, new AbortController().signal)).toHaveLength(
    2
  );
  unavailable = true;
  await expect(
    snapshot(registry, new AbortController().signal)
  ).rejects.toThrow("fixture outage");
  for (const p of registry.list()) await registry.remove(p.localProjectId);
  unavailable = false;
  expect(await snapshot(registry, new AbortController().signal)).toEqual([]);
});
