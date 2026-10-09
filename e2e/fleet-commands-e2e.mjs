import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  claimResponseSchema,
  commandRecordSchema,
  acknowledgmentSchema,
} from "../packages/management-protocol/dist/index.js";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "c07-blackbox-")));
const children = new Set();
let time = Date.parse("2026-10-09T12:00:00.000Z"),
  reached = 0;
function check(condition, label) {
  reached++;
  console.log(`reached: ${label}`);
  assert.ok(condition, label);
}
async function peer() {
  const child = fork(
    fileURLToPath(new URL("./fleet-commands-peer.mjs", import.meta.url)),
    [],
    {
      env: {
        ...process.env,
        C07_DATA: join(dir, "control"),
        C07_TIME: String(time),
      },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    }
  );
  children.add(child);
  await Promise.race([
    once(child, "message"),
    once(child, "exit").then(() => {
      throw new Error("Peer startup exited");
    }),
  ]);
  let sequence = 0;
  const pending = new Map();
  child.on("message", (message) => {
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  });
  return {
    async call(method, ...args) {
      const id = ++sequence;
      const response = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("Peer RPC timeout"));
        }, 10_000);
        pending.set(id, (message) => {
          clearTimeout(timer);
          resolve(message);
        });
        child.send({ id, method, args });
      });
      return response;
    },
    async stop() {
      const exit = once(child, "exit");
      child.disconnect();
      await exit;
      children.delete(child);
    },
  };
}
const envelope = (identity) => ({
  protocolVersion: 1,
  environmentId: identity.environmentId,
  sessionId: identity.sessionId,
  requestId: randomUUID(),
});
let journal;
try {
  let api = await peer();
  let { identity, projectId } = (await api.call("initialize")).value;
  journal = new DatabaseSync(join(dir, "journal.sqlite"));
  journal.exec(
    "CREATE TABLE journal(command_id TEXT PRIMARY KEY,effect_started INTEGER NOT NULL DEFAULT 0,result TEXT); CREATE TABLE effects(command_id TEXT)"
  );
  async function submit(key, operation = "start", project = projectId) {
    return api.call("submit", project, key, { operation });
  }
  async function claim(commandId, candidate = identity) {
    return api.call("claim", candidate, { ...envelope(candidate), commandId });
  }
  function effect(commandId) {
    journal.exec("BEGIN IMMEDIATE");
    try {
      const changed = journal
        .prepare(
          "UPDATE journal SET effect_started=1 WHERE command_id=? AND effect_started=0"
        )
        .run(commandId).changes;
      if (changed)
        journal.prepare("INSERT INTO effects VALUES (?)").run(commandId);
      journal.exec("COMMIT");
    } catch (error) {
      journal.exec("ROLLBACK");
      throw error;
    }
  }
  await api.call("offline", projectId, true);
  check(
    (await submit("offline")).error?.code === "agent_offline",
    "CP06 offline submission rejected"
  );
  await api.call("offline", projectId, false);
  let accepted = (await submit("lost-claim")).value;
  journal
    .prepare("INSERT INTO journal(command_id) VALUES (?)")
    .run(accepted.commandId);
  const committed = (await claim(accepted.commandId)).value;
  claimResponseSchema.parse(committed);
  // Response was committed but is intentionally ignored; restart Control Plane.
  await api.stop();
  time += 30_001;
  api = await peer();
  const replay = (await claim(accepted.commandId)).value;
  check(
    replay.command.claimedAt === committed.command.claimedAt &&
      replay.command.state === "executing",
    "CP18 lost claim response preserves original ownership and deadline"
  );
  effect(accepted.commandId);
  effect(accepted.commandId);
  check(
    journal.prepare("SELECT count(*) AS n FROM effects").get().n === 1,
    "CP19 durable marker forbids duplicate local invocation"
  );
  const result = {
    kind: "command",
    commandId: accepted.commandId,
    state: "succeeded",
    observedAt: new Date(time - 300_000).toISOString(),
    evidence: { ready: true },
  };
  journal
    .prepare("UPDATE journal SET result=? WHERE command_id=?")
    .run(JSON.stringify(result), accepted.commandId);
  // Durable local result survives agent-journal close/reopen; no upload occurs yet.
  journal.close();
  journal = new DatabaseSync(join(dir, "journal.sqlite"));
  time += 30_000;
  await api.stop();
  api = await peer();
  await api.call("recover");
  check(
    (await api.call("get", accepted.commandId)).value.state === "unknown",
    "CP07 claimed missing report becomes unknown after restart"
  );
  const upload = {
    ...envelope(identity),
    result: JSON.parse(
      journal
        .prepare("SELECT result FROM journal WHERE command_id=?")
        .get(accepted.commandId).result
    ),
  };
  acknowledgmentSchema.parse(
    (await api.call("result", identity, upload)).value
  );
  time += 1_000;
  upload.result.observedAt = new Date(time + 300_000).toISOString();
  await api.stop();
  api = await peer();
  const acknowledged = await api.call("result", identity, upload);
  check(
    !acknowledged.error &&
      (await api.call("get", accepted.commandId)).value.state === "succeeded",
    "CP07 durable result reconciled and lost acknowledgment replayed"
  );
  check(
    (await api.call("get", accepted.commandId)).value.completedAt ===
      new Date(time - 1_000).toISOString(),
    "CP10 skewed result uses authoritative receipt time"
  );

  accepted = (await submit("unresolved", "stop")).value;
  await claim(accepted.commandId);
  time += 60_000;
  await api.call("clock", time);
  await api.call("recover");
  check(
    (await submit("hidden-replacement")).error?.code === "unresolved_command",
    "CP09 unknown fences replacement command"
  );
  const unknown = (
    await api.call("close", accepted.commandId, {
      acknowledged: true,
      reason: "No reliable process identity",
    })
  ).value;
  check(
    unknown.state === "unknown" && unknown.closure?.actor === "local-owner",
    "CP09 explicit closure preserves unknown outcome"
  );
  commandRecordSchema.parse(unknown);
  check(
    (await api.call("audits")).value.some(
      (a) =>
        a.operation === "command.close-unresolved" &&
        a.target === accepted.commandId
    ),
    "CP09 closure is durably audited"
  );
  const next = (await submit("fresh-after-close")).value;
  check(
    next.commandId !== accepted.commandId,
    "CP09 replacement gets fresh command identity"
  );

  const second = await peer();
  // Independent SQLite connections race expiry and first claim at the exact deadline.
  time += 30_000;
  await api.call("clock", time);
  await second.call("clock", time);
  const [raceClaim] = await Promise.all([
    claim(next.commandId),
    second.call("recover"),
  ]);
  check(
    raceClaim.error?.code === "command_expired" &&
      (await api.call("get", next.commandId)).value.state === "expired",
    "CP06 claim versus expiry at deadline commits expired"
  );
  await second.stop();
  const eligible = (await submit("before-deadline")).value;
  const concurrent = await peer();
  time += 29_999;
  await api.call("clock", time);
  await concurrent.call("clock", time);
  const [won] = await Promise.all([
    claim(eligible.commandId),
    concurrent.call("recover"),
  ]);
  check(
    won.value?.command.state === "executing",
    "CP06 first claim before deadline survives competing recovery"
  );
  await concurrent.stop();

  const old = { ...identity };
  identity = (await api.call("reconnect", identity)).value;
  check(
    (await claim(eligible.commandId, old)).error?.code ===
      "claim_owner_conflict",
    "CP19 stale session claim rejected"
  );
  check(
    (await claim(eligible.commandId)).error?.code === "claim_owner_conflict",
    "CP19 untransferred session has no ownership"
  );
  const transferred = (await api.call("transfer", identity, eligible.commandId))
    .value;
  check(
    transferred.state === "unknown" &&
      transferred.claimedAt === won.value.command.claimedAt,
    "CP19 transfer preserves original claim and only permits reconciliation"
  );
  check(
    (await claim(eligible.commandId)).value.command.state === "unknown",
    "CP19 unknown replay never restores executing"
  );
  await api.call("close", eligible.commandId, {
    acknowledged: true,
    reason: "Interrupted effect marker",
  });
  const revoked = (await submit("revoke-unclaimed")).value;
  await api.call("revoke", identity.environmentId);
  check(
    (await api.call("get", revoked.commandId)).value.state === "expired",
    "CP06 revocation expires only unclaimed work"
  );
  const history = (await api.call("history", projectId, { limit: 100 })).value;
  check(
    history.items.some(
      (c) => c.closure?.reason === "No reliable process identity"
    ),
    "CP09 history retains explicitly closed outcome"
  );
  console.log(
    `C07 black-box passed (${reached} assertions; ${process.platform}); fixture journal evidence, not native OS lifecycle validation`
  );
} finally {
  journal?.close();
  for (const child of children) {
    child.kill("SIGKILL");
    await once(child, "exit").catch(() => {});
  }
  rmSync(dir, { recursive: true, force: true });
}
