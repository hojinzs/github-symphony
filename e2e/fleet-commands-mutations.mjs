// Plant forbidden conditions in isolated copies of actual compiled C07 artifacts.
import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "fleet-blackbox-mutations-"));
const fleet = join(dir, "packages/fleet-control-plane");
try {
  for (const name of ["fleet-control-plane", "management-protocol"]) {
    cpSync(
      join(root, "packages", name, "dist"),
      join(dir, "packages", name, "dist"),
      { recursive: true }
    );
    writeFileSync(
      join(dir, "packages", name, "package.json"),
      JSON.stringify({ type: "module", exports: "./dist/index.js" })
    );
  }
  mkdirSync(join(dir, "node_modules/@gh-symphony"), { recursive: true });
  symlinkSync(
    join(dir, "packages/management-protocol"),
    join(dir, "node_modules/@gh-symphony/management-protocol"),
    "dir"
  );
  mkdirSync(join(dir, "e2e"));
  for (const name of ["fleet-commands-peer.mjs", "fleet-commands-e2e.mjs"])
    cpSync(join(root, "e2e", name), join(dir, "e2e", name));
  const cases = [
    [
      "commands",
      "updated.completedAt = receivedAt;",
      "updated.completedAt = new Date(now().getTime() + 1000).toISOString();",
      "CP10 skewed result uses authoritative receipt time",
    ],
    [
      "commands",
      "if (!target.online)",
      "if (false)",
      "CP06 offline submission rejected",
    ],
    [
      "commands",
      "command,\n            };",
      "command: {...command,claimedAt:now().toISOString()},\n            };",
      "CP18 lost claim response preserves original ownership and deadline",
    ],
    [
      "fixture-agent",
      "WHERE command_id=? AND effect_started=0",
      "WHERE command_id=?",
      "CP19 durable marker forbids duplicate local invocation",
    ],
    [
      "commands",
      "LIMITS.executionObservationTimeoutMs <=",
      "LIMITS.executionObservationTimeoutMs * 2 <=",
      "CP07 claimed missing report becomes unknown after restart",
    ],
    [
      "commands",
      "save(updated);",
      "/* lost durable result */",
      "CP07 durable result reconciled and lost acknowledgment replayed",
    ],
    [
      "commands",
      'active.state === "unknown"\n                        ? "unresolved_command"\n                        : "command_conflict"',
      '"command_conflict"',
      "CP09 unknown fences replacement command",
    ],
    [
      "commands",
      'audit(command, "command.close-unresolved", OPERATOR_ACTOR);',
      'audit(command, "command.close-unresolved", OPERATOR_ACTOR); return {...command, state:"succeeded"};',
      "CP09 explicit closure preserves unknown outcome",
    ],
    [
      "commands",
      'audit(command, "command.close-unresolved", OPERATOR_ACTOR);',
      "/* omitted closure audit */",
      "CP09 closure is durably audited",
    ],
    [
      "fixture-peer",
      'case "submit":',
      'case "submit": if(args[1]==="fresh-after-close") return {commandId:store.database.prepare("SELECT command_id FROM lifecycle_commands WHERE closed_at IS NOT NULL LIMIT 1").get().command_id,state:"accepted"};',
      "CP09 replacement gets fresh command identity",
    ],
    [
      "commands",
      "Date.parse(command.expiresAt) <= current",
      "Date.parse(command.expiresAt) < current",
      "CP06 claim versus expiry at deadline commits expired",
    ],
    [
      "commands",
      "Date.parse(command.expiresAt) <= current",
      "Date.parse(command.expiresAt) <= current + 1",
      "CP06 first claim before deadline survives competing recovery",
    ],
    [
      "commands",
      "options.peers.verifyAgent(db, identity) !== true",
      "false",
      "CP19 stale session claim rejected",
    ],
    [
      "commands",
      "command.owner.sessionId !== identity.sessionId",
      "false",
      "CP19 untransferred session has no ownership",
    ],
    [
      "commands",
      'if (command.state === "executing")\n                    command.state = "unknown";',
      "/* transfer keeps executable state */",
      "CP19 transfer preserves original claim and only permits reconciliation",
    ],
    [
      "commands",
      "command,\n            };",
      'command: command.state==="unknown" ? {...command,state:"executing"} : command,\n            };',
      "CP19 unknown replay never restores executing",
    ],
    [
      "commands",
      'const command = { ...record(row), state: "expired" };',
      'const command = { ...record(row), state: "accepted" };',
      "CP06 revocation expires only unclaimed work",
    ],
    [
      "commands",
      "WHERE project_id=? AND rowid<? ORDER BY rowid DESC",
      "WHERE project_id=? AND rowid<? AND closed_at IS NULL ORDER BY rowid DESC",
      "CP09 history retains explicitly closed outcome",
    ],
  ];
  for (const [file, before, after, assertion] of cases) {
    const path =
      file === "fixture-agent"
        ? join(dir, "e2e/fleet-commands-e2e.mjs")
        : file === "fixture-peer"
          ? join(dir, "e2e/fleet-commands-peer.mjs")
          : join(fleet, "dist", file + ".js");
    const source = readFileSync(path, "utf8");
    assert.ok(source.includes(before), `Mutation target absent: ${file}`);
    try {
      writeFileSync(path, source.replace(before, after));
      const result = spawnSync(
        process.execPath,
        [join(dir, "e2e/fleet-commands-e2e.mjs")],
        { encoding: "utf8", timeout: 30_000 }
      );
      assert.ok(
        result.status !== 0 && result.status !== null,
        `Forbidden condition did not fail: ${assertion}`
      );
      assert.ok(
        result.stdout.includes(`reached: ${assertion}`),
        `Assertion not reached: ${assertion}`
      );
      assert.ok(
        result.stderr.includes("AssertionError"),
        `Failure was not an assertion: ${assertion}`
      );
      console.log(`proved red: ${assertion}`);
    } finally {
      writeFileSync(path, source);
    }
  }
  console.log(
    `C07 black-box forbidden-condition probes passed (18 assertions; ${process.platform})`
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
