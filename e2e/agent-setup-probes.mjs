import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const assertions = {
  help: "shared install help and version",
  resume: "CP-22 saved enrollment resumes without token input",
  identity: "CP-22 conflicting server preserves identity",
  permissions: "private identity permissions",
  signal: "CP-21 empty host sends authenticated first signal",
  lock: "CP-23 conflicting foreground process is rejected",
  allowlist: "existing folder allowlist is routed through shared CLI",
  linux: "CP-22 linux partial service setup resumes after lock release",
  darwin: "CP-22 darwin partial service setup resumes after lock release",
  secret: "token and credential absent from CLI diagnostics",
};
for (const [probe, assertion] of Object.entries(assertions)) {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL("./agent-setup-e2e.mjs", import.meta.url))],
    {
      env: { ...process.env, AGENT_SETUP_PLANT_FORBIDDEN: probe },
      encoding: "utf8",
      timeout: 30000,
    }
  );
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, `${probe} forbidden condition passed`);
  assert.ok(
    output.includes(`reached: ${assertion}`) &&
      output.includes("AssertionError"),
    `${probe} failed before intended assertion: ${output}`
  );
  console.log(
    `${probe}: intended assertion reached and forbidden condition rejected`
  );
}
