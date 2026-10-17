import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AgentRegistry } from "@gh-symphony/management-agent";
import type {
  AgentControlPlaneClient,
  ProjectObservation,
  ResultRequest,
} from "@gh-symphony/management-protocol";
import { runAgentRuntime } from "./agent-runtime.js";

it("composes actual inventory and bounded read adapters against typed independent peer ports", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-runtime-")));
  const directory = join(root, "agent");
  const folder = join(root, "prepared");
  await mkdir(folder);
  const registry = await AgentRegistry.open(directory);
  const enrollment = {
    protocolVersion: 1 as const,
    requestId: "11111111-1111-4111-8111-111111111111",
    environmentId: "22222222-2222-4222-8222-222222222222",
    agentId: "33333333-3333-4333-8333-333333333333",
    credential: "fixture-secret",
  };
  await registry.saveIdentity("https://fixture.lan", enrollment);
  const project = await registry.add(folder);
  await registry.close();
  const controller = new AbortController();
  const observations: ProjectObservation[] = [];
  const results: ResultRequest[] = [];
  const projectId = "44444444-4444-4444-8444-444444444444";
  const sessionId = "55555555-5555-4555-8555-555555555555";
  const readId = "66666666-6666-4666-8666-666666666666";
  const ack = <
    T extends { requestId: string; environmentId: string; sessionId: string },
  >(
    request: T
  ) => ({
    protocolVersion: 1 as const,
    requestId: request.requestId,
    environmentId: request.environmentId,
    sessionId: request.sessionId,
    receivedAt: new Date().toISOString(),
  });
  const client: AgentControlPlaneClient = {
    async enroll() {
      throw new Error("Unexpected enrollment");
    },
    async openSession(request) {
      return {
        protocolVersion: 1,
        requestId: request.requestId,
        environmentId: request.environmentId,
        sessionId,
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      };
    },
    async observe(request) {
      observations.push(...request.inventory.projects);
      return ack(request);
    },
    async poll(request) {
      return {
        ...request,
        commands: [],
        reads: [
          {
            readId,
            projectId,
            localProjectId: project.localProjectId,
            sessionId,
            submittedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60000).toISOString(),
            selection: { kind: "run-detail", runId: "absent-run" },
          },
        ],
      };
    },
    async claim() {
      throw new Error("No lifecycle command supplied");
    },
    async publishResult(request) {
      results.push(request);
      controller.abort();
      return ack(request);
    },
  };
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    await runAgentRuntime(
      {
        version: 1,
        dataDirectory: directory,
        projectConfigDir: join(root, "config"),
        nodePath: process.execPath,
        cliPath: process.argv[1]!,
      },
      {
        signal: controller.signal,
        ports: {
          client: () => client,
          async resolveIdentities(environmentId, ids) {
            expect(ids).toEqual([project.localProjectId]);
            return [{ environmentId, localProjectId: ids[0], projectId }];
          },
        },
      }
    );
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      projectId,
      canonicalPath: folder,
      validation: { state: "invalid" },
      process: { state: "stopped" },
    });
    expect(results).toHaveLength(1);
    expect(results[0].result).toMatchObject({
      kind: "read",
      result: { readId, state: "unavailable" },
    });
    expect(JSON.stringify(observations)).not.toContain("fixture-secret");
    const reopened = await AgentRegistry.open(directory);
    await reopened.close();
  } finally {
    clearTimeout(timeout);
    await rm(root, { recursive: true, force: true });
  }
});
