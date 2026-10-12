// Isolated artifact mutations prove reached black-box assertions reject forbidden
// conditions. Never mutate the checkout or accept startup/syntax failures as proof.
import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const repository = fileURLToPath(new URL("../", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "c06-artifact-mutations-"));
try {
  for (const name of ["fleet-control-plane", "management-protocol", "cli"]) {
    cpSync(
      join(repository, "packages", name, "dist"),
      join(root, "packages", name, "dist"),
      { recursive: true }
    );
    writeFileSync(
      join(root, "packages", name, "package.json"),
      JSON.stringify({ type: "module", exports: "./dist/index.js" })
    );
    if (name === "cli")
      symlinkSync(
        join(repository, "packages/cli/node_modules"),
        join(root, "packages/cli/node_modules"),
        "dir"
      );
  }
  mkdirSync(join(root, "node_modules/@gh-symphony"), { recursive: true });
  symlinkSync(
    join(root, "packages/management-protocol"),
    join(root, "node_modules/@gh-symphony/management-protocol"),
    "dir"
  );
  mkdirSync(join(root, "e2e"));
  cpSync(
    join(repository, "e2e/fleet-observations-e2e.mjs"),
    join(root, "e2e/fleet-observations-e2e.mjs")
  );
  const fleet = "packages/fleet-control-plane/dist/";
  const chunk = readdirSync(join(root, "packages/cli/dist")).find(
    (name) =>
      name.endsWith(".js") &&
      readFileSync(join(root, "packages/cli/dist", name), "utf8").includes(
        "return groups.map("
      )
  );
  assert.ok(chunk, "bundled publisher artifact located");
  const agent = `packages/cli/dist/${chunk}`;
  const cases = [
    [
      fleet + "observations.js",
      "WHERE environment_id=? AND agent_id=? AND local_project_id=?",
      "WHERE environment_id=? AND ? IS NOT NULL AND local_project_id=?",
      "replacement enrollment allocates distinct project UUID",
    ],
    [
      fleet + "observations.js",
      "row.agent_id !== null &&\n            row.agent_id === env.agent_id &&",
      "",
      "replacement partial inventory cannot revive old host target",
    ],
    [
      fleet + "observations.js",
      "outstanding >= LIMITS.managedProjectsPerAgent",
      "false",
      "cumulative unpublished identity cap rejects overflow",
    ],
    [
      fleet + "enrollment.js",
      "connection = 'online', last_contact_at",
      "connection = 'awaiting-signal', last_contact_at",
      "CP21 empty inventory is online",
    ],
    [
      fleet + "observations.js",
      "Number(count.n) === inventory.pageCount",
      "Number(count.n) >= 1",
      "partial revision retains unseen membership and advances status",
    ],
    [
      fleet + "observations.js",
      "ids.some((id) => previousIds.includes(id))",
      "false",
      "duplicate cross-page identity rejected",
    ],
    [
      fleet + "observations.js",
      "const managed = allIds.has(String(row.project_id));",
      "const managed = allIds.has(String(row.project_id)) || row.managed === 1;",
      "complete revision revokes removed membership",
    ],
    [
      fleet + "store.js",
      'database.exec("ROLLBACK");',
      'database.exec("COMMIT");',
      "peer fault rolls back inventory and command invalidation",
    ],
    [
      fleet + "commands.js",
      'const command = { ...record(row), state: "expired" };',
      'const command = { ...record(row), state: "accepted" };',
      "C07 complete removal expires unclaimed command",
    ],
    [
      fleet + "observations.js",
      "observation.snapshot === undefined && previous?.snapshot !== undefined",
      "false",
      "failed snapshot retains last successful data",
    ],
    [
      agent,
      "return groups.map(",
      "return groups.slice(0, 1).map(",
      "publisher splits bounded revision pages",
    ],
    [
      fleet + "observations.js",
      "v.map((s) => s.trim())",
      "v.map((s) => s)",
      "CP17 normalized identical scope warning",
    ],
    [
      fleet + "observations.js",
      "row.environment_id !== environmentId ||\n                    row.agent_id !== environment(environmentId)?.agent_id",
      "false",
      "foreign environment project cannot overwrite state",
    ],
    [
      fleet + "observations.js",
      'p.fresh && p.observation.process.state === "running"',
      'p.observation.process.state === "running"',
      "CP10 skewed clock cannot keep running count fresh",
    ],
    [
      fleet + "observations.js",
      "            observation,\n            fresh,",
      '            observation: connection === "offline" ? {...observation, process: {state:"unknown", observedAt:observation.observedAt, diagnostic:{code:"process_unverified",message:"Lost cached state"}}} : observation,\n            fresh,',
      "CP05 restart retains stale process observations",
    ],
    [
      fleet + "sessions.js",
      "!(Date.parse(current.expires_at) > now().getTime())",
      "false",
      "restart rejects old session observation",
    ],
    [
      fleet + "observations.js",
      "if (outside(unknown, item.environmentId) ||",
      "if (false && (outside(unknown, item.environmentId)) ||",
      "current-session recovery leaves offline overlap unverified",
    ],
    [
      fleet + "observations.js",
      "input.limit ?? LIMITS.defaultPageSize",
      "input.limit ?? 100",
      "operator project paging retains separate historical rows",
    ],
    [
      fleet + "observations.js",
      "if (decoded.scope !== scope)",
      "if (false)",
      "changed filter resets cursor",
    ],
    [
      agent,
      "projects: state.projects.filter((entry) => entry.localProjectId !== id)",
      "projects: state.projects",
      "CP14 current publisher excludes removed allowlist folder",
    ],
    [
      fleet + "commands.js",
      'if (env?.enrollment !== "enrolled")',
      "if (false)",
      "revoked inventory command reports access_revoked",
    ],
  ];
  for (const [relative, from, to, label] of cases) {
    const path = join(root, relative),
      original = readFileSync(path, "utf8");
    assert.ok(original.includes(from), `mutation anchor: ${label}`);
    try {
      writeFileSync(path, original.replace(from, to));
      const run = spawnSync(
        process.execPath,
        [join(root, "e2e/fleet-observations-e2e.mjs")],
        {
          encoding: "utf8",
          timeout: 30_000,
          env: { ...process.env, C06_FLEET_ARTIFACT_ROOT: root },
        }
      );
      const output = run.stdout + run.stderr;
      assert.ok(
        output.includes(`reached: ${label}`),
        `assertion reached: ${label}\n${output}`
      );
      assert.notEqual(run.status, 0, `forbidden condition must fail: ${label}`);
      assert.ok(
        output.includes("AssertionError"),
        `assertion failure, not environment error: ${label}\n${output}`
      );
      console.log(`mutation RED: ${label}`);
    } finally {
      writeFileSync(path, original);
    }
  }
  console.log(
    `C06 mutation PASS: ${cases.length} isolated forbidden conditions reached and failed their assertions`
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
