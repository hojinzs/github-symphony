// Plant durable/runtime forbidden conditions; require the named assertion, not an incidental crash.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const runner = fileURLToPath(
  new URL("./agent-executor-e2e.mjs", import.meta.url)
);
for (const [probe, label] of [
  ["invalid-start", "CP03 invalid running workflow rejects fleet start"],
  [
    "unsafe-invalid-stop",
    "CP03 invalid workflow unverified stop sends no signal",
  ],
  [
    "invalid-stop-completion",
    "CP03 invalid workflow verified fleet stop exits and releases locks",
  ],

  [
    "duplicate-result",
    "CP07 duplicate result resends after managed folder disappears",
  ],
  ["claim-time", "CP18 original ownership and claim time retained"],
  [
    "result",
    "CP07 unchanged result survives agent and fleet restart and ownership transfer",
  ],
  [
    "marker",
    "CP09 marker-only agent crash remains unknown without effect replay",
  ],
  [
    "expiry",
    "CP06 expired unclaimed receipt never invokes effects or becomes unknown",
  ],
  [
    "replacement",
    "CP08 replacement B survives saved-target recovery without a new signal",
  ],
]) {
  const result = spawnSync(process.execPath, [runner], {
    env: { ...process.env, C08_PLANT_FORBIDDEN: probe },
    encoding: "utf8",
    timeout: 120_000,
  });
  const output = result.stdout + result.stderr;
  assert.notEqual(result.status, 0, `Forbidden ${probe} unexpectedly passed`);
  assert.ok(
    output.includes(`reached: ${label}`) &&
      output.includes("AssertionError") &&
      output.includes(label),
    `Forbidden ${probe} did not fail its reached assertion: ${output}`
  );
  console.log(`${probe}: assertion reached and failed as required`);
}
