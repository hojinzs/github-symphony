import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  LIMITS,
  observationRequestSchema,
  type AgentControlPlaneClient,
  type ObservationRequest,
  type ProjectObservation,
  type PollResponse,
} from "@gh-symphony/management-protocol";
import { AgentRegistry } from "./registry.js";
import { AgentTransportError } from "./transport.js";
import {
  runForegroundAgent,
  reconnectDelay,
  observationPages,
} from "./foreground.js";
let root: string;
let controller: AbortController;
let observations: ObservationRequest[];
let opens: number;
let polls: number;
let waits: number[];
let peer: Pick<AgentControlPlaneClient, "openSession" | "observe" | "poll">;
const identity = {
  protocolVersion: 1 as const,
  requestId: randomUUID(),
  environmentId: randomUUID(),
  agentId: randomUUID(),
  credential: "fixture-secret",
};
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "c05-foreground-")));
  const registry = await AgentRegistry.open(join(root, "agent"));
  await registry.saveIdentity("https://fixture.example", identity);
  await registry.close();
  controller = new AbortController();
  observations = [];
  opens = 0;
  polls = 0;
  waits = [];
  peer = {
    async openSession(request) {
      opens++;
      return {
        protocolVersion: 1,
        requestId: request.requestId,
        environmentId: request.environmentId,
        sessionId: randomUUID(),
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      };
    },
    async observe(request) {
      observations.push(observationRequestSchema.parse(request));
      return {
        protocolVersion: 1,
        environmentId: request.environmentId,
        sessionId: request.sessionId,
        requestId: request.requestId,
        receivedAt: new Date().toISOString(),
      };
    },
    async poll(request) {
      polls++;
      controller.abort();
      return { ...request, commands: [], reads: [] };
    },
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function options() {
  return {
    directory: join(root, "agent"),
    agentVersion: "fixture-cli",
    signal: controller.signal,
    client: () => peer,
    snapshot: async () => [] as ProjectObservation[],
    random: () => 0,
    wait: async (ms: number, signal: AbortSignal) => {
      waits.push(ms);
      if (ms === 5_000)
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener("abort", () => resolve(), { once: true });
        });
    },
  };
}
it("sends empty first signal before polling and releases the exclusive local lock on shutdown", async () => {
  peer.poll = async (request) => {
    expect(observations).toHaveLength(1);
    polls++;
    controller.abort();
    return { ...request, commands: [], reads: [] };
  };
  await runForegroundAgent(options());
  expect(observations[0].inventory.projects).toEqual([]);
  expect(observations[0].sequence).toBe(0);
  expect(opens).toBe(1);
  const reopened = await AgentRegistry.open(join(root, "agent"));
  await reopened.close();
});
it("reuses its session after network loss and resends only a freshly collected snapshot", async () => {
  peer.poll = async (request) => {
    polls++;
    if (polls === 1) throw new AgentTransportError("network_failure", true);
    controller.abort();
    return { ...request, commands: [], reads: [] };
  };
  await runForegroundAgent(options());
  expect(opens).toBe(1);
  expect(observations).toHaveLength(2);
  expect(observations[1].sequence).toBeGreaterThan(observations[0].sequence);
  expect(observations[1].inventory.revisionId).not.toBe(
    observations[0].inventory.revisionId
  );
  expect(waits).toContain(500);
});
it("reopens an expired session with a fresh sequence and stops after credential revocation", async () => {
  peer.poll = async (request) => {
    polls++;
    if (polls === 1) throw new AgentTransportError("unauthenticated", false);
    controller.abort();
    return { ...request, commands: [], reads: [] };
  };
  await runForegroundAgent(options());
  expect(opens).toBe(2);
  expect(observations.map((o) => o.sequence)).toEqual([0, 0]);
  expect(observations[1].sessionId).not.toBe(observations[0].sessionId);
  controller = new AbortController();
  peer.openSession = async () => {
    throw new AgentTransportError("unauthenticated", false);
  };
  await expect(runForegroundAgent(options())).rejects.toThrow(
    "unauthenticated"
  );
});
it("rejects an incompatible session before any heartbeat and sanitizes unexpected errors", async () => {
  peer.openSession = async () => ({ protocolVersion: 2 }) as never;
  await expect(runForegroundAgent(options())).rejects.toThrow(
    "invalid_peer_response"
  );
  expect(observations).toEqual([]);
  peer.openSession = async () => {
    throw new Error(identity.credential);
  };
  await expect(runForegroundAgent(options())).rejects.toThrow(
    /^Management transport: foreground_failure$/
  );
});
it("paces a fast empty poll and does not dispatch an unbound delivery", async () => {
  const input: PollResponse["reads"][number] = {
    readId: randomUUID(),
    projectId: randomUUID(),
    localProjectId: "fixture-project",
    sessionId: randomUUID(),
    submittedAt: "2026-10-09T00:00:00Z",
    expiresAt: "2026-10-09T00:00:30Z",
    selection: { kind: "runs", limit: 1 },
  };
  peer.poll = async (request) => {
    polls++;
    if (polls === 1) return { ...request, commands: [], reads: [] };
    return {
      ...request,
      commands: [],
      reads: [{ ...input, sessionId: request.sessionId }],
    };
  };
  await expect(runForegroundAgent(options())).rejects.toThrow(
    "delivery_handler_required"
  );
  expect(waits).toContain(1_000);
});
it("caps exponential jitter and splits the current inventory into bounded sequenced pages", () => {
  expect(reconnectDelay(0, () => 0)).toBe(500);
  expect(reconnectDelay(1, () => 0)).toBe(1_000);
  expect(reconnectDelay(100, () => 1)).toBe(30_000);
  const envelope = {
    protocolVersion: 1 as const,
    environmentId: identity.environmentId,
    sessionId: randomUUID(),
    requestId: randomUUID(),
  };
  const project = (): ProjectObservation => ({
    projectId: randomUUID(),
    localProjectId: randomUUID(),
    displayName: "Fixture",
    canonicalPath: "/fixture/project",
    cliVersion: "fixture-cli",
    validation: { state: "valid" },
    process: { state: "stopped", observedAt: "2026-10-09T00:00:00Z" },
    observedAt: "2026-10-09T00:00:00Z",
    runs: [],
    snapshot: "x".repeat(2 * 1024 * 1024),
  });
  const pages = observationPages(
    envelope,
    [project(), project(), project()],
    7
  );
  expect(pages).toHaveLength(3);
  expect(pages.map((p) => p.sequence)).toEqual([7, 8, 9]);
  expect(new Set(pages.map((p) => p.inventory.revisionId)).size).toBe(1);
  for (const page of pages) {
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(
      LIMITS.observationBodyBytes
    );
    observationRequestSchema.parse(page);
  }
  expect(() =>
    observationPages(
      envelope,
      [{ ...project(), snapshot: "x".repeat(4 * 1024 * 1024) }],
      0
    )
  ).toThrow("observation_too_large");
});

it("keeps heartbeats flowing while a long poll is outstanding and cancels that poll", async () => {
  let heartbeatWaits = 0;
  let outstanding = false;
  peer.poll = async (request) => {
    outstanding = true;
    await new Promise<void>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
    return { ...request, commands: [], reads: [] };
  };
  const originalObserve = peer.observe;
  peer.observe = async (request) => {
    const result = await originalObserve(request);
    if (observations.length === 2) {
      expect(outstanding).toBe(true);
      controller.abort();
    }
    return result;
  };
  await runForegroundAgent({
    ...options(),
    wait: async (ms, signal) => {
      if (ms === 5_000 && heartbeatWaits++ === 0) {
        // Yield once so the concurrent poll enters its pending response.
        await new Promise((resolve) => setImmediate(resolve));
      } else if (!signal.aborted) {
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true })
        );
      }
    },
  });
  expect(observations).toHaveLength(2);
});

it("increases capped reconnect waits across failed negotiations without deleting saved identity", async () => {
  const open = peer.openSession;
  peer.openSession = async (request) => {
    opens++;
    if (opens === 1) throw new AgentTransportError("network_failure", true);
    if (opens === 2) throw new AgentTransportError("session_conflict", false);
    return open(request);
  };
  await runForegroundAgent(options());
  expect(waits.filter((ms) => ms < 5_000)).toEqual([500, 1_000]);
  const registry = await AgentRegistry.open(join(root, "agent"));
  expect(registry.identity?.credential).toBe(identity.credential);
  await registry.close();
});
