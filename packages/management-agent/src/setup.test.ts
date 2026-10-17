import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { AgentControlPlaneClient } from "@gh-symphony/management-protocol";
import { AgentRegistry } from "./registry.js";
import { setupAgent, type SetupService } from "./setup.js";

it("resumes saved enrollment after installation failure without token or allowlist changes and releases lock before start", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-setup-"));
  const directory = join(root, "agent");
  const folder = join(root, "project");
  await mkdir(folder);
  let registry = await AgentRegistry.open(directory);
  await registry.add(folder);
  const projects = registry.list();
  await registry.close();
  let exchanges = 0;
  let prompts = 0;
  let fail = true;
  const stages: string[] = [];
  const client: Pick<AgentControlPlaneClient, "enroll"> = {
    async enroll(request) {
      exchanges++;
      expect(request.token).toBe("one-use-fixture");
      return {
        protocolVersion: 1,
        requestId: request.requestId,
        agentId: "11111111-1111-4111-8111-111111111111",
        environmentId: "22222222-2222-4222-8222-222222222222",
        credential: "fixture-credential",
      };
    },
  };
  const service: SetupService = {
    async check() {
      return ["Login session only"];
    },
    async install() {
      if (fail) throw new Error("fixture install failure");
    },
    async start() {
      registry = await AgentRegistry.open(directory);
      expect(registry.list()).toEqual(projects);
      await registry.close();
    },
  };
  const options = {
    directory,
    serverOrigin: "https://fixture.lan",
    client,
    service,
    async readToken() {
      prompts++;
      return "one-use-fixture";
    },
    report(stage: string) {
      stages.push(stage);
    },
  };
  try {
    await expect(setupAgent(options)).rejects.toThrow(
      "fixture install failure"
    );
    fail = false;
    await setupAgent(options);
    expect(exchanges).toBe(1);
    expect(prompts).toBe(1);
    expect(stages).toEqual([
      "prerequisites",
      "enrolled",
      "prerequisites",
      "resumed",
      "installed",
      "started",
    ]);
    await expect(
      setupAgent({ ...options, serverOrigin: "https://other.lan" })
    ).rejects.toThrow("another server");
    expect(prompts).toBe(1);
    registry = await AgentRegistry.open(directory);
    await expect(setupAgent(options)).rejects.toThrow();
    await registry.close();
    expect(exchanges).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
