// Run reached forbidden-condition probes with isolated temp data per process.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const base = dirname(fileURLToPath(import.meta.url));
const mode = process.argv.includes("--native") ? "--native" : "--simulate";
const cases = {
  linger: "CP-23 linger limits explicit",
  repeat: "CP-22 same install resumes without reenrollment",
  invalid: "CP-22 invalid prepared workflow rejected",
  started: "CP-23 remote start uses actual orchestrator",
  environment: "CP-23 project strips inherited credentials",
  "stop-data":
    "CP-23 stop preserves orchestrator preserves registry and journal",
  "restart-data":
    "CP-23 restart preserves orchestrator preserves registry and journal",
  "uninstall-data":
    "CP-23 uninstall preserves orchestrator preserves registry and journal",
  definition: "CP-23 uninstall removes definition",
  ...(mode === "--native"
    ? { parser: "C11 native systemd parser accepts definition" }
    : { diagnostics: "CP-23 simulated diagnostics exclude credentials" }),
  package: "C11 packaged typed Linux adapter",
  identity: "CP-22 failed install preserves identity",
  credential: "CP-22 unit excludes credentials",
  lock: "CP-23 foreground owner conflict rejected",
  cgroup: "CP-23 disjoint control group readback",
  stop: "CP-23 stop preserves orchestrator",
  restart: "CP-23 restart preserves orchestrator",
  uninstall: "CP-23 uninstall preserves orchestrator",
};
for (const [probe, assertion] of Object.entries(cases)) {
  const result = spawnSync(
    process.execPath,
    [join(base, "linux-agent-service-e2e.mjs"), mode],
    {
      env: { ...process.env, C11_PLANT_FORBIDDEN: probe },
      encoding: "utf8",
      timeout: 90_000,
    }
  );
  const text = result.stdout + result.stderr;
  assert.ok(
    result.status !== 0 &&
      result.status !== 69 &&
      !result.error &&
      text.includes(`reached: ${assertion}`) &&
      text.includes("AssertionError"),
    `${probe} did not fail at its reached assertion: ${text}`
  );
  console.log(
    `${probe}: reached ${assertion}; forbidden condition failed as required`
  );
}
