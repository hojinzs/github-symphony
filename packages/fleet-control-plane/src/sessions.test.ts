import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it } from "vitest";
import type {
  EnrollmentResponse,
  ObservationRequest,
  SessionRequest,
} from "@gh-symphony/management-protocol";
import { createCommandService } from "./commands.js";
import { openFleetStore, type FleetStore } from "./store.js";
import {
  createEnrollmentService,
  type EnrollmentService,
} from "./enrollment.js";
import {
  createSessionService,
  SESSION_LIFETIME_MS,
  type SessionService,
} from "./sessions.js";

let root: string;
let store: FleetStore;
let enrollment: EnrollmentService;
let sessions: SessionService;
let identity: EnrollmentResponse;
let now: Date;
let projected: number[];
function request(): SessionRequest {
  return {
    protocolVersion: 1,
    requestId: randomUUID(),
    environmentId: identity.environmentId,
    agentId: identity.agentId,
    agentVersion: "fixture-cli",
    host: { hostname: "peer-host", os: "linux" },
  };
}
function observation(sessionId: string, sequence = 0): ObservationRequest {
  return {
    protocolVersion: 1,
    requestId: randomUUID(),
    environmentId: identity.environmentId,
    sessionId,
    sequence,
    observedAt: "2099-01-01T00:00:00Z",
    inventory: {
      revisionId: randomUUID(),
      pageIndex: 0,
      pageCount: 1,
      projects: [],
    },
  };
}
function create() {
  enrollment = createEnrollmentService(store, {
    now: () => now,
    invalidateManagementAccess: (database, environmentId) => {
      sessions.invalidate(database, environmentId);
      return undefined;
    },
  });
  sessions = createSessionService(store, enrollment, {
    now: () => now,
    receiveObservation: (database, input) => {
      projected.push(input.sequence);
      database
        .prepare("INSERT INTO projection_receipts VALUES (?)")
        .run(input.sequence);
      return undefined;
    },
  });
}
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "c05-session-")));
  store = openFleetStore(root);
  store.database.exec("CREATE TABLE projection_receipts (sequence INTEGER)");
  now = new Date("2026-10-09T10:00:00Z");
  projected = [];
  create();
  const token = await enrollment.createEnvironment({ name: "Fixture host" });
  identity = await enrollment.enroll({
    protocolVersion: 1,
    requestId: randomUUID(),
    token: token.token,
  });
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});
it("preserves awaiting-signal across restart and expiry before the first observation", async () => {
  sessions.recoverAfterRestart();
  expect((await enrollment.listEnvironments())[0].connection).toBe(
    "awaiting-signal"
  );
  const first = await sessions.openSession(identity, request());
  now = new Date(now.getTime() + SESSION_LIFETIME_MS);
  sessions.expire();
  expect((await enrollment.listEnvironments())[0].connection).toBe(
    "awaiting-signal"
  );
  expect(() =>
    sessions.authenticateSession({ ...identity, sessionId: first.sessionId })
  ).toThrow("Current");
  const next = await sessions.openSession(identity, request());
  store.close();
  store = openFleetStore(root);
  create();
  sessions.recoverAfterRestart();
  expect((await enrollment.listEnvironments())[0].connection).toBe(
    "awaiting-signal"
  );
  expect(() =>
    sessions.authenticateSession({ ...identity, sessionId: next.sessionId })
  ).toThrow("Current");
  const recovered = await sessions.openSession(identity, request());
  await sessions.observe(identity, observation(recovered.sessionId));
  expect((await enrollment.listEnvironments())[0].connection).toBe("online");
});
it("atomically rejects a live second session and fences its expired predecessor", async () => {
  const first = await sessions.openSession(identity, request());
  await expect(sessions.openSession(identity, request())).rejects.toThrow(
    "live session"
  );
  now = new Date(now.getTime() + SESSION_LIFETIME_MS);
  const second = await sessions.openSession(identity, request());
  expect(second.sessionId).not.toBe(first.sessionId);
  expect(() =>
    sessions.authenticateSession({ ...identity, sessionId: first.sessionId })
  ).toThrow("Current");
  await expect(
    sessions.observe(identity, observation(first.sessionId))
  ).rejects.toThrow("Current");
  await sessions.observe(identity, observation(second.sessionId));
});
it("changes awaiting-signal to online with empty inventory using receipt time, ignoring older observations", async () => {
  const session = await sessions.openSession(identity, request());
  expect((await enrollment.listEnvironments())[0].connection).toBe(
    "awaiting-signal"
  );
  await sessions.observe(identity, observation(session.sessionId, 2));
  expect((await enrollment.listEnvironments())[0]).toMatchObject({
    connection: "online",
    lastContactAt: now.toISOString(),
    agentVersion: "fixture-cli",
    host: { hostname: "peer-host", os: "linux" },
  });
  await sessions.observe(identity, observation(session.sessionId, 1));
  await sessions.observe(identity, observation(session.sessionId, 2));
  expect(projected).toEqual([2]);
  expect(
    store.database.prepare("SELECT sequence FROM projection_receipts").all()
  ).toEqual([{ sequence: 2 }]);
  now = new Date(now.getTime() + SESSION_LIFETIME_MS);
  sessions.expire();
  expect((await enrollment.listEnvironments())[0].connection).toBe("offline");
});
it("rejects incompatible, foreign, malformed and revoked identities before projection", async () => {
  await expect(
    sessions.openSession(identity, {
      ...request(),
      protocolVersion: 2,
    } as unknown as SessionRequest)
  ).rejects.toThrow("Unsupported");
  await expect(
    sessions.openSession(identity, {
      ...request(),
      environmentId: randomUUID(),
    })
  ).rejects.toThrow("identity");
  const session = await sessions.openSession(identity, request());
  await expect(
    sessions.observe(
      { ...identity, credential: "wrong" },
      observation(session.sessionId)
    )
  ).rejects.toThrow("credential");
  await expect(
    sessions.observe(identity, {
      ...observation(session.sessionId),
      sequence: -1,
    })
  ).rejects.toThrow("integer");
  await enrollment.revoke(identity.environmentId);
  await expect(
    sessions.observe(identity, observation(session.sessionId))
  ).rejects.toThrow("credential");
  expect(projected).toEqual([]);
});
it("rolls projection and sequence back together and resumes from a failed observation", async () => {
  const session = await sessions.openSession(identity, request());
  store.database.exec(
    "CREATE TRIGGER fail_receipt BEFORE INSERT ON projection_receipts BEGIN SELECT RAISE(ABORT, 'projection fault'); END"
  );
  await expect(
    sessions.observe(identity, observation(session.sessionId, 3))
  ).rejects.toThrow("projection fault");
  expect((await enrollment.listEnvironments())[0].connection).toBe(
    "awaiting-signal"
  );
  store.database.exec("DROP TRIGGER fail_receipt");
  projected = [];
  await sessions.observe(identity, observation(session.sessionId, 3));
  expect(projected).toEqual([3]);
  expect((await enrollment.listEnvironments())[0].connection).toBe("online");
});
it("fences persisted sessions on explicit service restart without deleting enrollment", async () => {
  const first = await sessions.openSession(identity, request());
  await sessions.observe(identity, observation(first.sessionId));
  store.close();
  store = openFleetStore(root);
  create();
  sessions.recoverAfterRestart();
  expect((await enrollment.listEnvironments())[0].connection).toBe("offline");
  await expect(
    sessions.observe(identity, observation(first.sessionId))
  ).rejects.toThrow("Current");
  const next = await sessions.openSession(identity, request());
  await sessions.observe(identity, observation(next.sessionId));
  expect((await enrollment.listEnvironments())[0].connection).toBe("online");
});

it("composes lifecycle claims with authenticated exclusive current sessions", async () => {
  const first = await sessions.openSession(identity, request());
  await sessions.observe(identity, observation(first.sessionId));
  const projectId = randomUUID();
  const localProjectId = randomUUID();
  const commands = createCommandService(store, {
    now: () => now,
    peers: {
      resolveTarget(database, candidate) {
        expect(database).toBe(store.database);
        if (candidate !== projectId) return undefined;
        const current = database
          .prepare(
            "SELECT agent_id, session_id FROM agent_sessions WHERE environment_id = ?"
          )
          .get(identity.environmentId)!;
        return {
          projectId,
          localProjectId,
          environmentId: identity.environmentId,
          agentId: String(current.agent_id),
          sessionId: String(current.session_id),
          managed: true,
          online: true,
          valid: true,
          supported: true,
        };
      },
      verifyAgent(database, candidate) {
        expect(database).toBe(store.database);
        sessions.authenticateSession(candidate);
        return true;
      },
    },
  });
  const accepted = await commands.submitCommand(projectId, "current-session", {
    operation: "start",
  });
  const firstIdentity = { ...identity, sessionId: first.sessionId };
  const claim = (sessionId: string) => ({
    protocolVersion: 1 as const,
    requestId: randomUUID(),
    environmentId: identity.environmentId,
    sessionId,
    commandId: accepted.commandId,
  });
  await expect(
    commands.claim(
      { ...firstIdentity, credential: "wrong" },
      claim(first.sessionId)
    )
  ).rejects.toThrow("credential");
  const claimed = await commands.claim(firstIdentity, claim(first.sessionId));
  expect(claimed.command).toMatchObject({
    sessionId: first.sessionId,
    state: "executing",
    owner: { agentId: identity.agentId, sessionId: first.sessionId },
  });
  now = new Date(now.getTime() + SESSION_LIFETIME_MS);
  await expect(
    commands.claim(firstIdentity, claim(first.sessionId))
  ).rejects.toThrow("Current");
  const next = await sessions.openSession(identity, request());
  await expect(
    commands.claim(firstIdentity, claim(first.sessionId))
  ).rejects.toThrow("Current");
  const nextIdentity = { ...identity, sessionId: next.sessionId };
  const transferred = commands.transferOwnership(
    nextIdentity,
    accepted.commandId
  );
  expect(transferred).toMatchObject({
    state: "unknown",
    sessionId: first.sessionId,
    owner: { agentId: identity.agentId, sessionId: next.sessionId },
    claimedAt: claimed.command.claimedAt,
  });
  await expect(
    commands.claim(nextIdentity, claim(next.sessionId))
  ).resolves.toMatchObject({
    command: { state: "unknown", owner: { sessionId: next.sessionId } },
  });
  await enrollment.revoke(identity.environmentId);
  await expect(
    commands.claim(nextIdentity, claim(next.sessionId))
  ).rejects.toThrow("credential");
});
