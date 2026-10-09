import { claimResponseSchema } from "@gh-symphony/management-protocol";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createCommandService } from "./commands.js";
import { openFleetStore, type FleetStore } from "./store.js";
import { createEnrollmentService } from "./enrollment.js";
import { commandPeers } from "../test-fixtures/command-peers.js";

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
async function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-commands-")));
  let store: FleetStore = openFleetStore(dir);
  cleanup.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let clock = Date.parse("2026-10-09T12:00:00.000Z");
  const now = () => new Date(clock);
  const fixture = await commandPeers(store, now);
  const service = () =>
    createCommandService(store, { peers: fixture.peers, now });
  return {
    ...fixture,
    dir,
    now,
    service,
    db: store.database,
    get store() {
      return store;
    },
    advance(ms: number) {
      clock += ms;
    },
    reopen() {
      store.close();
      store = openFleetStore(dir);
      return service();
    },
    envelope() {
      return {
        protocolVersion: 1 as const,
        environmentId: fixture.identity.environmentId,
        sessionId: fixture.identity.sessionId,
        requestId: randomUUID(),
      };
    },
  };
}

it("deduplicates submission before offline checks and rejects conflicting reuse", async () => {
  const f = await setup();
  const api = f.service();
  const project = f.project();
  const first = await api.submitCommand(project, "click", {
    operation: "start",
  });
  f.db
    .prepare("UPDATE fixture_projects SET online=0 WHERE project_id=?")
    .run(project);
  expect(
    await api.submitCommand(project, "click", { operation: "start" })
  ).toEqual(first);
  await expect(
    api.submitCommand(project, "click", { operation: "stop" })
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
  await expect(
    api.submitCommand(f.project(), "click", { operation: "start" })
  ).rejects.toMatchObject({ code: "idempotency_conflict" });
  expect((await f.reopen().getCommand(first.commandId)).state).toBe("accepted");
});

it.each([
  ["online", "agent_offline"],
  ["managed", "project_unmanaged"],
  ["valid", "project_invalid"],
  ["supported", "unsupported_protocol"],
] as const)(
  "rejects unavailable target %s without recording a command",
  async (column, code) => {
    const f = await setup();
    const api = f.service();
    const p = f.project();
    f.db.exec(`UPDATE fixture_projects SET ${column}=0`);
    await expect(
      api.submitCommand(p, "key", { operation: "start" })
    ).rejects.toMatchObject({ code });
    expect(
      f.db.prepare("SELECT count(*) AS n FROM lifecycle_commands").get()
    ).toEqual({ n: 0 });
  }
);

it("rejects malformed submission, missing project and busy project/agent", async () => {
  const f = await setup();
  const api = f.service();
  const p = f.project();
  await expect(
    api.submitCommand(p, " ", { operation: "start" })
  ).rejects.toMatchObject({ code: "invalid_input" });
  await expect(
    api.submitCommand(randomUUID(), "none", { operation: "start" })
  ).rejects.toMatchObject({ code: "not_found" });
  await api.submitCommand(p, "one", { operation: "start" });
  await expect(
    api.submitCommand(p, "two", { operation: "stop" })
  ).rejects.toMatchObject({ code: "command_conflict" });
  for (let n = 0; n < 3; n++)
    await api.submitCommand(f.project(), `capacity-${n}`, {
      operation: "start",
    });
  await expect(
    api.submitCommand(f.project(), "fifth", { operation: "start" })
  ).rejects.toMatchObject({ code: "agent_busy" });
});

it("commits expiry before rejecting a first claim at the authoritative deadline", async () => {
  const f = await setup();
  const api = f.service();
  const p = f.project();
  const c = await api.submitCommand(p, "expiry", { operation: "start" });
  f.advance(30_000);
  await expect(
    api.claim(f.identity, { ...f.envelope(), commandId: c.commandId })
  ).rejects.toMatchObject({ code: "command_expired" });
  expect((await api.getCommand(c.commandId)).state).toBe("expired");
  api.recover();
  expect((await api.getCommand(c.commandId)).owner).toBeUndefined();
  expect(
    await api.submitCommand(p, "fresh", { operation: "start" })
  ).toMatchObject({ state: "accepted" });
});

it("replays a lost claim response without resetting claim time or execution timeout", async () => {
  const f = await setup();
  const api = f.service();
  const p = f.project();
  const c = await api.submitCommand(p, "claim", { operation: "start" });
  const req = { ...f.envelope(), commandId: c.commandId };
  const claimed = await api.claim(f.identity, req);
  expect(() => claimResponseSchema.parse(claimed)).not.toThrow();
  expect(claimed.command).toMatchObject({
    state: "executing",
    claimedAt: "2026-10-09T12:00:00.000Z",
    owner: { agentId: f.identity.agentId, sessionId: f.identity.sessionId },
  });
  f.advance(30_001);
  const replay = await f.reopen().claim(f.identity, req);
  expect(replay.command).toEqual(claimed.command);
  f.advance(29_999);
  const expiredExecution = await f.service().claim(f.identity, req);
  expect(expiredExecution.command.state).toBe("unknown");
  expect(expiredExecution.command.claimedAt).toBe(claimed.command.claimedAt);
  await expect(
    f.service().submitCommand(p, "replacement", { operation: "stop" })
  ).rejects.toMatchObject({ code: "unresolved_command" });
});

it("fences stale/foreign claim and result ownership; transfer authorizes only reconciliation", async () => {
  const f = await setup();
  const api = f.service();
  const c = await api.submitCommand(f.project(), "owner", {
    operation: "stop",
  });
  const req = { ...f.envelope(), commandId: c.commandId };
  await api.claim(f.identity, req);
  const stale = { ...f.identity };
  f.identity.sessionId = randomUUID();
  f.db
    .prepare("UPDATE fixture_sessions SET session_id=?")
    .run(f.identity.sessionId);
  await expect(api.claim(stale, req)).rejects.toMatchObject({
    code: "claim_owner_conflict",
  });
  await expect(
    api.claim(f.identity, { ...f.envelope(), commandId: c.commandId })
  ).rejects.toMatchObject({ code: "claim_owner_conflict" });
  const foreign = { ...f.identity, agentId: randomUUID() };
  expect(() => api.transferOwnership(foreign, c.commandId)).toThrow();
  const transferred = api.transferOwnership(f.identity, c.commandId);
  expect(transferred).toMatchObject({
    state: "unknown",
    claimedAt: "2026-10-09T12:00:00.000Z",
    owner: { sessionId: f.identity.sessionId },
  });
  const replay = await api.claim(f.identity, {
    ...f.envelope(),
    commandId: c.commandId,
  });
  expect(replay.command.state).toBe("unknown");
  await expect(
    api.publishResult(stale, {
      ...f.envelope(),
      sessionId: stale.sessionId,
      result: {
        kind: "command",
        commandId: c.commandId,
        state: "succeeded",
        observedAt: f.now().toISOString(),
        evidence: {},
      },
    })
  ).rejects.toMatchObject({ code: "claim_owner_conflict" });
});

it("reconciles a durable lost result after restart and acknowledges identical terminal replay", async () => {
  const f = await setup();
  const api = f.service();
  const c = await api.submitCommand(f.project(), "result", {
    operation: "start",
  });
  await api.claim(f.identity, { ...f.envelope(), commandId: c.commandId });
  f.advance(60_000);
  const reopened = f.reopen();
  reopened.recover();
  expect((await reopened.getCommand(c.commandId)).state).toBe("unknown");
  const result = {
    kind: "command" as const,
    commandId: c.commandId,
    state: "succeeded" as const,
    observedAt: "2026-10-09T12:00:05.000Z",
    evidence: { ready: true },
  };
  expect(
    await reopened.publishResult(f.identity, { ...f.envelope(), result })
  ).toMatchObject({ receivedAt: f.now().toISOString() });
  const final = await reopened.getCommand(c.commandId);
  expect(final).toMatchObject({
    state: "succeeded",
    completedAt: "2026-10-09T12:00:05.000Z",
    evidence: { ready: true },
  });
  await reopened.publishResult(f.identity, {
    ...f.envelope(),
    result: { ...result, evidence: { ready: true } },
  });
  expect(await reopened.getCommand(c.commandId)).toEqual(final);
  expect(
    (
      await reopened.claim(f.identity, {
        ...f.envelope(),
        commandId: c.commandId,
      })
    ).command.state
  ).toBe("succeeded");
  await expect(
    reopened.publishResult(f.identity, {
      ...f.envelope(),
      result: { ...result, state: "failed" },
    })
  ).rejects.toMatchObject({ code: "command_conflict" });
});

it("requires claimed results and rejects future or pre-claim evidence", async () => {
  const f = await setup();
  const api = f.service();
  const c = await api.submitCommand(f.project(), "result-invalid", {
    operation: "start",
  });
  const result = {
    kind: "command" as const,
    commandId: c.commandId,
    state: "failed" as const,
    observedAt: f.now().toISOString(),
    evidence: null,
  };
  await expect(
    api.publishResult(f.identity, { ...f.envelope(), result })
  ).rejects.toMatchObject({ code: "claim_owner_conflict" });
  await api.claim(f.identity, { ...f.envelope(), commandId: c.commandId });
  for (const observedAt of [
    "2026-10-09T11:59:59.000Z",
    "2026-10-09T12:00:01.000Z",
  ]) {
    await expect(
      api.publishResult(f.identity, {
        ...f.envelope(),
        result: { ...result, observedAt },
      })
    ).rejects.toMatchObject({ code: "invalid_input" });
  }
  expect((await api.getCommand(c.commandId)).state).toBe("executing");
});

it("audits explicit unknown closure without inventing success or allowing late replacement results", async () => {
  const f = await setup();
  const api = f.service();
  const p = f.project();
  const c = await api.submitCommand(p, "unknown", { operation: "stop" });
  await expect(
    api.closeUnresolved(c.commandId, { acknowledged: true, reason: "close" })
  ).rejects.toMatchObject({ code: "command_conflict" });
  await api.claim(f.identity, { ...f.envelope(), commandId: c.commandId });
  f.advance(60_000);
  api.recover();
  await expect(
    api.closeUnresolved(c.commandId, {
      acknowledged: false,
      reason: "close",
    } as never)
  ).rejects.toMatchObject({ code: "invalid_input" });
  await expect(
    api.closeUnresolved(c.commandId, { acknowledged: true, reason: " " })
  ).rejects.toMatchObject({ code: "invalid_input" });
  const closed = await api.closeUnresolved(c.commandId, {
    acknowledged: true,
    reason: "Insufficient process identity",
  });
  expect(closed).toMatchObject({
    state: "unknown",
    closure: {
      actor: "local-owner",
      reason: "Insufficient process identity",
      closedAt: "2026-10-09T12:01:00.000Z",
    },
  });
  expect(
    await api.closeUnresolved(c.commandId, {
      acknowledged: true,
      reason: "Insufficient process identity",
    })
  ).toEqual(closed);
  expect(
    f.db
      .prepare(
        "SELECT count(*) AS n FROM audit_records WHERE operation='command.close-unresolved'"
      )
      .get()
  ).toEqual({ n: 1 });
  await api.submitCommand(p, "replacement", { operation: "start" });
  await expect(
    api.publishResult(f.identity, {
      ...f.envelope(),
      result: {
        kind: "command",
        commandId: c.commandId,
        state: "succeeded",
        observedAt: f.now().toISOString(),
        evidence: {},
      },
    })
  ).rejects.toMatchObject({ code: "command_conflict" });
  expect((await api.listCommands(p, { limit: 10 })).items).toHaveLength(2);
});

it("retains unresolved records indefinitely and prunes only aged terminal/closed records and audits", async () => {
  const f = await setup();
  const api = f.service();
  const unresolved = await api.submitCommand(f.project(), "unresolved", {
    operation: "start",
  });
  await api.claim(f.identity, {
    ...f.envelope(),
    commandId: unresolved.commandId,
  });
  const closed = await api.submitCommand(f.project(), "closed", {
    operation: "stop",
  });
  await api.claim(f.identity, { ...f.envelope(), commandId: closed.commandId });
  f.advance(60_000);
  api.recover();
  await api.closeUnresolved(closed.commandId, {
    acknowledged: true,
    reason: "unverified",
  });
  const expired = await api.submitCommand(f.project(), "expired", {
    operation: "start",
  });
  f.advance(30_000);
  api.recover();
  const retention = 90 * 24 * 60 * 60_000;
  f.advance(retention - 30_000);
  expect(api.prune().commands).toBe(1); // closed at 12:01, expired at 12:01:30
  expect((await api.getCommand(unresolved.commandId)).state).toBe("unknown");
  expect((await api.getCommand(expired.commandId)).state).toBe("expired");
  f.advance(30_000);
  expect(api.prune().commands).toBe(1);
  expect(api.prune().commands).toBe(0);
  expect((await api.getCommand(unresolved.commandId)).state).toBe("unknown");
});

it("pages project history and rejects cross-project or invalid cursors", async () => {
  const f = await setup();
  const api = f.service();
  const p = f.project();
  const ids: string[] = [];
  for (let n = 0; n < 3; n++) {
    const c = await api.submitCommand(p, `page-${n}`, { operation: "start" });
    ids.push(c.commandId);
    f.advance(30_000);
    api.recover();
  }
  const first = await api.listCommands(p, { limit: 2 });
  expect(first.items.map((c) => c.commandId)).toEqual([ids[2], ids[1]]);
  const second = await api.listCommands(p, {
    limit: 2,
    cursor: first.nextCursor,
  });
  expect(second.items.map((c) => c.commandId)).toEqual([ids[0]]);
  expect(second.nextCursor).toBeUndefined();
  await expect(
    api.listCommands(f.project(), { limit: 2, cursor: first.nextCursor })
  ).rejects.toMatchObject({ code: "invalid_input" });
  await expect(api.listCommands(p, { limit: 0 })).rejects.toMatchObject({
    code: "invalid_input",
  });
});

it("expires unclaimed revocation/removal work but leaves claimed work recoverable", async () => {
  const f = await setup();
  const api = f.service();
  const p = f.project();
  const accepted = await api.submitCommand(p, "removed", {
    operation: "start",
  });
  api.invalidateProject(p);
  expect((await api.getCommand(accepted.commandId)).state).toBe("expired");
  const executing = await api.submitCommand(f.project(), "executing", {
    operation: "stop",
  });
  await api.claim(f.identity, {
    ...f.envelope(),
    commandId: executing.commandId,
  });
  const pending = await api.submitCommand(f.project(), "revoked", {
    operation: "start",
  });
  f.db.exec("BEGIN IMMEDIATE");
  api.invalidateEnvironment(f.db, f.identity.environmentId);
  f.db.exec("COMMIT");
  expect((await api.getCommand(pending.commandId)).state).toBe("expired");
  expect((await api.getCommand(executing.commandId)).state).toBe("executing");
});

it("rolls back command mutation when audit persistence fails", async () => {
  const f = await setup();
  const api = f.service();
  const p = f.project();
  f.db.exec(
    "CREATE TRIGGER fail_command_audit BEFORE INSERT ON audit_records WHEN NEW.operation LIKE 'command.%' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END"
  );
  await expect(
    api.submitCommand(p, "rollback", { operation: "start" })
  ).rejects.toThrow("audit unavailable");
  expect(
    f.db.prepare("SELECT count(*) AS n FROM lifecycle_commands").get()
  ).toEqual({ n: 0 });
});

it("acknowledges a committed terminal result after reconnect without new execution permission", async () => {
  const f = await setup();
  const api = f.service();
  const c = await api.submitCommand(f.project(), "terminal-reconnect", {
    operation: "start",
  });
  await api.claim(f.identity, { ...f.envelope(), commandId: c.commandId });
  const result = {
    kind: "command" as const,
    commandId: c.commandId,
    state: "succeeded" as const,
    observedAt: f.now().toISOString(),
    evidence: { ready: true },
  };
  await api.publishResult(f.identity, { ...f.envelope(), result });
  const stale = { ...f.identity };
  f.identity.sessionId = randomUUID();
  f.db
    .prepare("UPDATE fixture_sessions SET session_id=?")
    .run(f.identity.sessionId);
  expect(api.transferOwnership(f.identity, c.commandId).state).toBe(
    "succeeded"
  );
  expect(
    (await api.claim(f.identity, { ...f.envelope(), commandId: c.commandId }))
      .command.state
  ).toBe("succeeded");
  await expect(
    api.publishResult(f.identity, { ...f.envelope(), result })
  ).resolves.toMatchObject({ sessionId: f.identity.sessionId });
  await expect(
    api.claim(stale, {
      ...f.envelope(),
      sessionId: stale.sessionId,
      commandId: c.commandId,
    })
  ).rejects.toMatchObject({ code: "claim_owner_conflict" });
});

it("combines C04 credential revocation and command invalidation in one rollback boundary", async () => {
  const f = await setup();
  const api = f.service();
  const c = await api.submitCommand(f.project(), "atomic-revoke", {
    operation: "start",
  });
  const peerStore = openFleetStore(f.dir);
  cleanup.push(() => peerStore.close());
  const enrollment = createEnrollmentService(peerStore, {
    now: f.now,
    invalidateManagementAccess(database, environmentId) {
      api.invalidateEnvironment(database, environmentId);
      return undefined;
    },
  });
  // A different SQLite connection must not be accepted as the shared transaction.
  await expect(enrollment.revoke(f.identity.environmentId)).rejects.toThrow(
    /shared active transaction/
  );
  expect((await api.getCommand(c.commandId)).state).toBe("accepted");
  f.enrollment.authenticate(f.identity);
});

it("rolls back revocation plus ledger expiry on audit failure and expires on successful C04 revoke", async () => {
  const f = await setup();
  const api = f.service();
  const c = await api.submitCommand(f.project(), "revoke", {
    operation: "start",
  });
  const enrollment = createEnrollmentService(f.store, {
    now: f.now,
    invalidateManagementAccess(database, environmentId) {
      return api.invalidateEnvironment(database, environmentId);
    },
  });
  f.db.exec(
    "CREATE TRIGGER fail_revoke BEFORE INSERT ON audit_records WHEN NEW.operation='environment.revoke' BEGIN SELECT RAISE(ABORT,'revoke audit unavailable'); END"
  );
  await expect(enrollment.revoke(f.identity.environmentId)).rejects.toThrow(
    "revoke audit unavailable"
  );
  expect((await api.getCommand(c.commandId)).state).toBe("accepted");
  enrollment.authenticate(f.identity);
  f.db.exec("DROP TRIGGER fail_revoke");
  await enrollment.revoke(f.identity.environmentId);
  expect((await api.getCommand(c.commandId)).state).toBe("expired");
  expect(() => enrollment.authenticate(f.identity)).toThrow();
});
