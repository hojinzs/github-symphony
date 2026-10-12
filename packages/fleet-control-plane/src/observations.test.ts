import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type {
  EnrollmentResponse,
  ProjectObservation,
  ObservationRequest,
} from "@gh-symphony/management-protocol";
import { openFleetStore, type FleetStore } from "./store.js";
import { createEnrollmentService } from "./enrollment.js";
import { createSessionService, type SessionService } from "./sessions.js";
import {
  createObservationService,
  type ObservationService,
} from "./observations.js";

let root: string;
let store: FleetStore;
let observations: ObservationService;
let sessions: SessionService;
let identity: EnrollmentResponse;
let sessionId: string;
let sequence: number;
let clock: Date;
let invalidated: string[];
const scope = {
  adapter: "github",
  bindingId: "project-1",
  repository: "owner/repo",
  activeStates: ["Ready", "In progress"],
  includeLabels: ["feature"],
  excludeLabels: [],
};
function compose() {
  observations = createObservationService(store, {
    now: () => clock,
    invalidateProject: (db, id) => {
      expect(db.isTransaction).toBe(true);
      invalidated.push(id);
      return undefined;
    },
  });
  const enrollment = createEnrollmentService(store, {
    now: () => clock,
    invalidateManagementAccess: (db, id) => {
      sessions.invalidate(db, id);
      return undefined;
    },
  });
  sessions = createSessionService(store, enrollment, {
    now: () => clock,
    receiveObservation: observations.receiveObservation,
  });
  return enrollment;
}
async function enrolled(name = "Host") {
  const enrollment = compose();
  const token = await enrollment.createEnvironment({ name });
  const credential = await enrollment.enroll({
    protocolVersion: 1,
    requestId: randomUUID(),
    token: token.token,
  });
  const session = await sessions.openSession(credential, {
    protocolVersion: 1,
    requestId: randomUUID(),
    environmentId: credential.environmentId,
    agentId: credential.agentId,
    agentVersion: "fixture",
    host: { hostname: name, os: "linux" },
  });
  return { credential, session };
}
function project(localProjectId = "prepared"): ProjectObservation {
  return {
    projectId: observations.identifyProjects(identity.environmentId, [
      localProjectId,
    ])[0],
    localProjectId,
    displayName: "Prepared",
    canonicalPath: "/prepared",
    cliVersion: "fixture",
    validation: { state: "valid" },
    process: {
      state: "running",
      observedAt: "2099-01-01T00:00:00Z",
      identity: "opaque",
      pid: 123,
    },
    observedAt: "2099-01-01T00:00:00Z",
    snapshot: { trackerScope: scope, health: "healthy" },
    snapshotObservedAt: "2099-01-01T00:00:00Z",
    runs: [],
  };
}
function request(
  projects: ProjectObservation[],
  revisionId = randomUUID(),
  pageIndex = 0,
  pageCount = 1
): ObservationRequest {
  return {
    protocolVersion: 1,
    requestId: randomUUID(),
    environmentId: identity.environmentId,
    sessionId,
    sequence: sequence++,
    observedAt: "2099-01-01T00:00:00Z",
    inventory: { revisionId, pageIndex, pageCount, projects },
  };
}
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "c06-observations-")));
  store = openFleetStore(root);
  clock = new Date("2026-10-12T00:00:00Z");
  invalidated = [];
  sequence = 0;
  const first = await enrolled();
  identity = first.credential;
  sessionId = first.session.sessionId;
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

it("commits complete membership atomically while partial pages advance existing status", async () => {
  const a = project("a"),
    b = project("b"),
    c = project("c");
  await sessions.observe(identity, request([a, b]));
  const revision = randomUUID();
  await sessions.observe(
    identity,
    request(
      [{ ...a, process: { state: "stopped", observedAt: a.observedAt } }],
      revision,
      0,
      2
    )
  );
  expect(
    (await observations.getProject(a.projectId)).observation.process.state
  ).toBe("stopped");
  expect((await observations.getProject(b.projectId)).managed).toBe(true);
  expect(await observations.listProjects()).toMatchObject({
    items: expect.arrayContaining([
      expect.objectContaining({ projectId: b.projectId }),
    ]),
  });
  await expect(observations.getProject(c.projectId)).rejects.toMatchObject({
    code: "not_found",
  });
  await sessions.observe(identity, request([c], revision, 1, 2));
  expect((await observations.getProject(b.projectId)).managed).toBe(false);
  expect((await observations.getProject(c.projectId)).managed).toBe(true);
  expect(invalidated).toEqual([b.projectId]);
  await sessions.observe(identity, request([]));
  expect(observations.summary()).toEqual({ freshRunning: 0, stale: 0 });
});
it("rejects inconsistent pages and forged identities without advancing sequence or heartbeat", async () => {
  const a = project("a"),
    b = project("b");
  const revision = randomUUID();
  await sessions.observe(identity, request([a], revision, 0, 2));
  const before = store.database
    .prepare("SELECT sequence,expires_at FROM agent_sessions")
    .get();
  clock = new Date(clock.getTime() + 1000);
  for (const input of [
    request([a], revision, 1, 2),
    request([b], revision, 1, 3),
    request([{ ...b, localProjectId: "forged" }], revision, 1, 2),
    request([b], randomUUID(), 1, 2),
    request([b], revision, 0, 2),
  ]) {
    await expect(sessions.observe(identity, input)).rejects.toMatchObject({
      code: "invalid_input",
    });
    expect(
      store.database
        .prepare("SELECT sequence,expires_at FROM agent_sessions")
        .get()
    ).toEqual(before);
  }
  await sessions.observe(identity, request([b], revision, 1, 2));
  expect((await observations.listProjects()).items).toHaveLength(2);
});
it("uses receipt freshness, ignores old sequence and retains failed snapshots and process state across restart", async () => {
  const a = project();
  const first = request([a]);
  await sessions.observe(identity, first);
  const failed = {
    ...a,
    snapshot: undefined,
    snapshotObservedAt: undefined,
    snapshotError: { code: "log_unavailable" as const, message: "Unavailable" },
  };
  await sessions.observe(identity, request([failed]));
  await sessions.observe(identity, {
    ...first,
    inventory: {
      ...first.inventory,
      projects: [
        { ...a, process: { state: "stopped", observedAt: a.observedAt } },
      ],
    },
  });
  const last = await observations.getProject(a.projectId);
  expect(last).toMatchObject({
    fresh: true,
    snapshotStale: true,
    observation: {
      snapshot: a.snapshot,
      snapshotObservedAt: a.snapshotObservedAt,
      process: { state: "running" },
    },
  });
  expect(last.lastReceivedAt).toBe(clock.toISOString());
  clock = new Date(clock.getTime() + 30_000);
  expect((await observations.getProject(a.projectId)).connection).toBe(
    "offline"
  );
  expect(observations.summary()).toEqual({ freshRunning: 0, stale: 1 });
  store.close();
  store = openFleetStore(root);
  compose();
  sessions.recoverAfterRestart();
  expect(await observations.getProject(a.projectId)).toMatchObject({
    fresh: false,
    observation: { process: { state: "running" }, snapshot: a.snapshot },
  });
});
it("fences partial revisions by session and recovers with a complete current revision", async () => {
  const a = project(),
    b = project("b");
  const revision = randomUUID();
  await sessions.observe(identity, request([a]));
  await sessions.observe(identity, request([b], revision, 0, 2));
  sessions.recoverAfterRestart();
  const next = await sessions.openSession(identity, {
    protocolVersion: 1,
    requestId: randomUUID(),
    environmentId: identity.environmentId,
    agentId: identity.agentId,
    agentVersion: "fixture",
    host: { hostname: "Host", os: "darwin" },
  });
  const oldSession = sessionId;
  sessionId = next.sessionId;
  sequence = 0;
  await expect(
    sessions.observe(identity, request([], revision, 1, 2))
  ).rejects.toMatchObject({ code: "invalid_input" });
  await expect(
    sessions.observe(identity, { ...request([]), sessionId: oldSession })
  ).rejects.toMatchObject({ code: "unauthenticated" });
  await sessions.observe(identity, request([b]));
  expect((await observations.getProject(a.projectId)).managed).toBe(false);
  expect(await observations.getProject(b.projectId)).toMatchObject({
    managed: true,
    fresh: true,
  });
});
it("isolates environment identities and normalizes only reported scope sets", async () => {
  const a = project();
  await sessions.observe(identity, request([a]));
  const firstIdentity = identity;
  const other = await enrolled("Other");
  identity = other.credential;
  sessionId = other.session.sessionId;
  sequence = 0;
  const b = project();
  expect(b.projectId).not.toBe(a.projectId);
  expect(
    observations.identifyProjects(firstIdentity.environmentId, [
      a.localProjectId,
    ])[0]
  ).toBe(a.projectId);
  await expect(sessions.observe(identity, request([a]))).rejects.toMatchObject({
    code: "invalid_input",
  });
  b.snapshot = {
    trackerScope: {
      ...scope,
      adapter: " GITHUB ",
      activeStates: [" In progress ", "Ready", "Ready"],
    },
  };
  await sessions.observe(identity, request([b]));
  expect((await observations.getProject(a.projectId)).warnings).toEqual([
    { state: "identical", projectIds: [a.projectId, b.projectId].sort() },
  ]);
  await sessions.observe(
    identity,
    request([
      {
        ...b,
        snapshot: { trackerScope: { ...scope, includeLabels: ["other"] } },
      },
    ])
  );
  expect((await observations.getProject(a.projectId)).warnings).toEqual([]);
  await sessions.observe(identity, request([{ ...b, snapshot: {} }]));
  expect((await observations.getProject(a.projectId)).warnings).toEqual([
    { state: "unverified", projectIds: [a.projectId] },
  ]);
});
it("pages deterministically with default/maximum limits and rejects invalid or changed-filter cursors", async () => {
  const projects = Array.from({ length: 30 }, (_, i) => project(`p${i}`));
  await sessions.observe(identity, request(projects));
  const first = await observations.listProjects();
  expect(first.items).toHaveLength(25);
  const second = await observations.listProjects({ cursor: first.nextCursor });
  expect(second.items).toHaveLength(5);
  expect(
    new Set([...first.items, ...second.items].map((p) => p.projectId)).size
  ).toBe(30);
  expect(second.nextCursor).toBeUndefined();
  await expect(
    observations.listProjects({ cursor: first.nextCursor, process: "running" })
  ).rejects.toMatchObject({ code: "cursor_reset" });
  await expect(
    observations.listProjects({ cursor: "garbage" })
  ).rejects.toMatchObject({ code: "cursor_reset" });
  await expect(observations.listProjects({ limit: 101 })).rejects.toThrow();
  expect(
    (await observations.listProjects({ process: "stopped" })).items
  ).toEqual([]);
});
it("revokes moved folders immediately and supplies safe command targets without treating invalid workflow as unmanaged", async () => {
  const a = project();
  await sessions.observe(identity, request([a]));
  const target = () =>
    store.transaction(() =>
      observations.resolveTarget(store.database, a.projectId)
    );
  expect(target()).toMatchObject({
    managed: true,
    valid: true,
    online: true,
    agentId: identity.agentId,
    sessionId,
  });
  await sessions.observe(
    identity,
    request([
      {
        ...a,
        validation: {
          state: "invalid",
          diagnostic: { code: "project_invalid", message: "Invalid workflow" },
        },
      },
    ])
  );
  expect(target()).toMatchObject({ managed: true, valid: false });
  await sessions.observe(
    identity,
    request(
      [
        {
          ...a,
          validation: {
            state: "invalid",
            diagnostic: { code: "project_unmanaged", message: "Moved" },
          },
        },
      ],
      randomUUID(),
      0,
      2
    )
  );
  expect(target()).toMatchObject({ managed: false });
  expect(invalidated).toEqual([a.projectId]);
  expect(() =>
    observations.receiveObservation(store.database, request([]))
  ).toThrow("transaction");
});
