import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { openFleetStore } from "./store.js";
import { createReadService } from "./reads.js";
import { createCommandService } from "./commands.js";
import { commandPeers } from "../test-fixtures/command-peers.js";
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));
async function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-reads-")));
  const store = openFleetStore(dir);
  cleanup.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let clock = Date.now();
  const now = () => new Date(clock);
  const fixture = await commandPeers(store, now);
  const api = createReadService(store, { peers: fixture.peers, now });
  return {
    ...fixture,
    api,
    store,
    now,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
it("bounds reads independently of lifecycle commands and expires at the deadline", async () => {
  const f = await setup();
  const projects = Array.from({ length: 5 }, () => f.project());
  await createCommandService(f.store, {
    peers: f.peers,
    now: f.now,
  }).submitCommand(projects[0], "start", { operation: "start" });
  const reads = [];
  for (const project of projects.slice(0, 4))
    reads.push(await f.api.submitRead(project, { kind: "runs", limit: 10 }));
  await expect(
    f.api.submitRead(projects[0], { kind: "runs", limit: 10 })
  ).rejects.toMatchObject({ code: "read_busy" });
  await expect(
    f.api.submitRead(projects[4], { kind: "runs", limit: 10 })
  ).rejects.toMatchObject({ code: "read_busy" });
  expect(f.api.poll(f.identity)).toHaveLength(4);
  f.advance(30_000);
  expect(await f.api.getRead(reads[0].readId)).toMatchObject({
    state: "expired",
  });
  expect(f.api.poll(f.identity)).toHaveLength(0);
  await expect(
    f.api.submitRead(projects[4], { kind: "runs", limit: 10 })
  ).resolves.toMatchObject({ state: "pending" });
});
it("validates detail identity and holds receipt-timestamped results only for 60 seconds", async () => {
  const f = await setup();
  const read = await f.api.submitRead(f.project(), {
    kind: "run-detail",
    runId: "run-1",
  });
  const envelope = {
    protocolVersion: 1 as const,
    environmentId: f.identity.environmentId,
    sessionId: f.identity.sessionId,
    requestId: randomUUID(),
  };
  const result = {
    readId: read.readId,
    state: "completed" as const,
    completedAt: f.now().toISOString(),
    payload: { kind: "run-detail" as const, runId: "run-2", detail: {} },
  };
  await expect(
    f.api.publishResult(f.identity, {
      ...envelope,
      result: { kind: "read", result },
    })
  ).rejects.toMatchObject({ code: "invalid_input" });
  result.payload.runId = "run-1";
  await f.api.publishResult(f.identity, {
    ...envelope,
    result: { kind: "read", result },
  });
  expect(await f.api.getRead(read.readId)).toMatchObject({
    state: "completed",
    completedAt: f.now().toISOString(),
  });
  f.advance(60_000);
  expect(await f.api.getRead(read.readId)).toMatchObject({
    state: "unavailable",
  });
});
it("reports disconnection and restart as unavailable without empty success", async () => {
  const f = await setup();
  const project = f.project();
  const read = await f.api.submitRead(project, { kind: "runs", limit: 10 });
  f.store.database
    .prepare("UPDATE fixture_projects SET online=0 WHERE project_id=?")
    .run(project);
  expect(await f.api.getRead(read.readId)).toMatchObject({
    state: "unavailable",
  });
  await expect(
    f.api.submitRead(project, { kind: "runs", limit: 10 })
  ).rejects.toMatchObject({ code: "agent_offline" });
  f.store.database
    .prepare("UPDATE fixture_projects SET online=1 WHERE project_id=?")
    .run(project);
  const second = await f.api.submitRead(project, { kind: "runs", limit: 10 });
  f.api.recover();
  expect(await f.api.getRead(second.readId)).toMatchObject({
    state: "unavailable",
  });
});

it("rejects admission when retained results fill the configured registry", async () => {
  const f = await setup();
  const api = createReadService(f.store, {
    peers: f.peers,
    now: f.now,
    maximumEntries: 1,
  });
  const first = await api.submitRead(f.project(), { kind: "runs", limit: 1 });
  api.recover();
  await expect(
    api.submitRead(f.project(), { kind: "runs", limit: 1 })
  ).rejects.toMatchObject({ code: "read_busy" });
  expect(await api.getRead(first.readId)).toMatchObject({
    state: "unavailable",
  });
  f.advance(60_000);
  await expect(
    api.submitRead(f.project(), { kind: "runs", limit: 1 })
  ).resolves.toMatchObject({ state: "pending" });
});

it("does not accept asynchronous truthy authentication peers", async () => {
  const f = await setup();
  const api = createReadService(f.store, {
    peers: {
      ...f.peers,
      verifyAgent: (() =>
        Promise.resolve(false)) as unknown as typeof f.peers.verifyAgent,
    },
    now: f.now,
  });
  expect(() => api.poll(f.identity)).toThrow(
    "Current authenticated session required"
  );
});

it("fences wrong result sessions, enforces log byte limits and preserves reset", async () => {
  const f = await setup();
  const read = await f.api.submitRead(f.project(), {
    kind: "log-chunk",
    runId: "run-1",
    stream: "worker",
    maxBytes: 4,
  });
  const envelope = {
    protocolVersion: 1 as const,
    environmentId: f.identity.environmentId,
    sessionId: f.identity.sessionId,
    requestId: randomUUID(),
  };
  const result = {
    readId: read.readId,
    state: "completed" as const,
    completedAt: f.now().toISOString(),
    payload: {
      kind: "log-chunk" as const,
      runId: "run-1",
      stream: "worker" as const,
      text: "ééé",
      cursor: "generation-offset",
      reset: true,
      eof: false,
    },
  };
  await expect(
    f.api.publishResult(f.identity, {
      ...envelope,
      sessionId: randomUUID(),
      result: { kind: "read", result },
    })
  ).rejects.toMatchObject({ code: "claim_owner_conflict" });
  await expect(
    f.api.publishResult(f.identity, {
      ...envelope,
      result: { kind: "read", result },
    })
  ).rejects.toMatchObject({ code: "invalid_input" });
  result.payload.text = "éé";
  await f.api.publishResult(f.identity, {
    ...envelope,
    result: { kind: "read", result },
  });
  await f.api.publishResult(f.identity, {
    ...envelope,
    result: { kind: "read", result },
  });
  expect(await f.api.getRead(read.readId)).toMatchObject({
    state: "completed",
    payload: { text: "éé", reset: true },
  });
  result.payload.text = "other";
  await expect(
    f.api.publishResult(f.identity, {
      ...envelope,
      result: { kind: "read", result },
    })
  ).rejects.toMatchObject({ code: "invalid_input" });
});

it("marks completed content historical offline and offers bounded summaries to the projection owner", async () => {
  const f = await setup();
  f.store.database.exec(
    "CREATE TABLE fixture_read_history(project_id TEXT PRIMARY KEY, received_at TEXT, runs TEXT)"
  );
  const api = createReadService(f.store, {
    peers: f.peers,
    now: f.now,
    receiveRunSummaries(database, projectId, runs, receivedAt) {
      database
        .prepare("INSERT INTO fixture_read_history VALUES (?,?,?)")
        .run(projectId, receivedAt, JSON.stringify(runs));
      return undefined;
    },
  });
  const project = f.project();
  const read = await api.submitRead(project, { kind: "runs", limit: 1 });
  const runs = [
    {
      runId: "r1",
      status: "succeeded",
      startedAt: f.now().toISOString(),
      updatedAt: f.now().toISOString(),
    },
  ];
  await api.publishResult(f.identity, {
    protocolVersion: 1,
    environmentId: f.identity.environmentId,
    sessionId: f.identity.sessionId,
    requestId: randomUUID(),
    result: {
      kind: "read",
      result: {
        readId: read.readId,
        state: "completed",
        completedAt: f.now().toISOString(),
        payload: { kind: "runs", runs },
      },
    },
  });
  expect(api.getReadView(read.readId)).toMatchObject({
    historical: false,
    result: { state: "completed" },
  });
  f.store.database
    .prepare("UPDATE fixture_projects SET online=0 WHERE project_id=?")
    .run(project);
  expect(api.getReadView(read.readId)).toMatchObject({
    historical: true,
    result: { state: "completed" },
  });
  const cached = f.store.database
    .prepare("SELECT * FROM fixture_read_history WHERE project_id=?")
    .get(project)!;
  expect(JSON.parse(String(cached.runs))).toEqual(runs);
  f.advance(60_000);
  expect(api.getReadView(read.readId)).toMatchObject({
    result: { state: "unavailable" },
  });
  expect(
    f.store.database
      .prepare("SELECT count(*) AS n FROM fixture_read_history")
      .get()!.n
  ).toBe(1);
});

it("rolls back failed summary projection and allows result retry without reoffering completed replay", async () => {
  const f = await setup();
  f.store.database.exec("CREATE TABLE fixture_offers(received_at TEXT)");
  let fail = true;
  const api = createReadService(f.store, {
    peers: f.peers,
    now: f.now,
    receiveRunSummaries(database, _projectId, _runs, receivedAt) {
      database.prepare("INSERT INTO fixture_offers VALUES (?)").run(receivedAt);
      if (fail) throw new Error("projection unavailable");
      return undefined;
    },
  });
  const read = await api.submitRead(f.project(), { kind: "runs", limit: 1 });
  const request = {
    protocolVersion: 1 as const,
    environmentId: f.identity.environmentId,
    sessionId: f.identity.sessionId,
    requestId: randomUUID(),
    result: {
      kind: "read" as const,
      result: {
        readId: read.readId,
        state: "completed" as const,
        completedAt: f.now().toISOString(),
        payload: { kind: "runs" as const, runs: [] },
      },
    },
  };
  await expect(api.publishResult(f.identity, request)).rejects.toThrow(
    "projection unavailable"
  );
  expect(
    f.store.database.prepare("SELECT count(*) AS n FROM fixture_offers").get()!
      .n
  ).toBe(0);
  expect(await api.getRead(read.readId)).toMatchObject({ state: "pending" });
  fail = false;
  await api.publishResult(f.identity, request);
  await api.publishResult(f.identity, request);
  expect(
    f.store.database.prepare("SELECT count(*) AS n FROM fixture_offers").get()!
      .n
  ).toBe(1);
});

it("does not resurrect expired reads from a late completed result", async () => {
  const f = await setup();
  const read = await f.api.submitRead(f.project(), { kind: "runs", limit: 1 });
  f.advance(30_000);
  await f.api.publishResult(f.identity, {
    protocolVersion: 1,
    environmentId: f.identity.environmentId,
    sessionId: f.identity.sessionId,
    requestId: randomUUID(),
    result: {
      kind: "read",
      result: {
        readId: read.readId,
        state: "completed",
        completedAt: f.now().toISOString(),
        payload: { kind: "runs", runs: [] },
      },
    },
  });
  expect(await f.api.getRead(read.readId)).toMatchObject({ state: "expired" });
});

it("rejects oversized run detail payloads before retaining them", async () => {
  const f = await setup();
  const read = await f.api.submitRead(f.project(), {
    kind: "run-detail",
    runId: "r1",
  });
  await expect(
    f.api.publishResult(f.identity, {
      protocolVersion: 1,
      environmentId: f.identity.environmentId,
      sessionId: f.identity.sessionId,
      requestId: randomUUID(),
      result: {
        kind: "read",
        result: {
          readId: read.readId,
          state: "completed",
          completedAt: f.now().toISOString(),
          payload: {
            kind: "run-detail",
            runId: "r1",
            detail: "x".repeat(256 * 1024),
          },
        },
      },
    })
  ).rejects.toMatchObject({ code: "invalid_input" });
  expect(await f.api.getRead(read.readId)).toMatchObject({ state: "pending" });
});

it("rejects revoked enrollment even when a projection has stale online state", async () => {
  const f = await setup();
  const project = f.project();
  const target = f.peers.resolveTarget(f.store.database, project)!;
  const api = createReadService(f.store, {
    peers: { ...f.peers, resolveTarget: () => target },
    now: f.now,
  });
  await f.enrollment.revoke(f.identity.environmentId);
  await expect(
    api.submitRead(project, { kind: "runs", limit: 1 })
  ).rejects.toMatchObject({ code: "access_revoked" });
});

it("scopes identical local project IDs to their enrolled environments", async () => {
  const f = await setup();
  const other = await commandPeers(f.store, f.now);
  const firstProject = f.project();
  const secondProject = other.project();
  const localId = f.store.database
    .prepare("SELECT local_id FROM fixture_projects WHERE project_id=?")
    .get(firstProject)!.local_id;
  f.store.database
    .prepare("UPDATE fixture_projects SET local_id=? WHERE project_id=?")
    .run(localId, secondProject);
  const first = await f.api.submitRead(firstProject, {
    kind: "runs",
    limit: 1,
  });
  const second = await f.api.submitRead(secondProject, {
    kind: "runs",
    limit: 1,
  });
  expect(f.api.poll(f.identity).map((r) => r.readId)).toEqual([first.readId]);
  expect(f.api.poll(other.identity).map((r) => r.readId)).toEqual([
    second.readId,
  ]);
  await expect(
    f.api.publishResult(other.identity, {
      protocolVersion: 1,
      environmentId: other.identity.environmentId,
      sessionId: other.identity.sessionId,
      requestId: randomUUID(),
      result: {
        kind: "read",
        result: {
          readId: first.readId,
          state: "completed",
          completedAt: f.now().toISOString(),
          payload: { kind: "runs", runs: [] },
        },
      },
    })
  ).rejects.toMatchObject({ code: "claim_owner_conflict" });
});
