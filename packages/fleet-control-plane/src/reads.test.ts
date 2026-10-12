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
