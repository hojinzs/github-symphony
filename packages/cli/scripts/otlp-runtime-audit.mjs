import assert from "node:assert/strict";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

// Child process of the clean-install audit, with its sanitized environment.
const [dist, runtimeRoot, mode, version] = process.argv.slice(2);
const enabled = mode !== "disabled";
const files = await readdir(dist);
let owner;
for (const name of files.filter(
  (name) => name.startsWith("chunk-") && name.endsWith(".js")
)) {
  const source = await readFile(join(dist, name), "utf8");
  if (source.includes("var OrchestratorService = class")) {
    owner = await import(pathToFileURL(join(dist, name)).href);
    break;
  }
}
assert.ok(
  owner?.OrchestratorService && owner?.createStore,
  "Packaged owner exports missing"
);
const projectIds = (await readdir(join(runtimeRoot, "projects"))).filter(
  (name) => name !== ".DS_Store"
);
assert.equal(projectIds.length, 1);
const project = JSON.parse(
  await readFile(
    join(runtimeRoot, "projects", projectIds[0], "project.json"),
    "utf8"
  )
);
const workflowPath = project.workflowSource.path;
const original = await readFile(workflowPath, "utf8");
const store = owner.createStore(runtimeRoot);
const service = new owner.OrchestratorService(store, project, {
  // H's existing internal input: this audit does not change any package API.
  telemetry: { productionCapability: true, version },
});
const ticks = [];
const percentile = (values) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
function cliStatus(json = true) {
  const result = spawnSync(
    process.execPath,
    [
      join(dist, "index.js"),
      "--config",
      runtimeRoot,
      ...(json ? ["--json"] : []),
      "project",
      "status",
      "--project-dir",
      project.projectDir,
    ],
    { encoding: "utf8", timeout: 15000 }
  );
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal((result.stdout + result.stderr).includes("audit-secret"), false);
  return json ? JSON.parse(result.stdout) : result.stdout;
}
async function update(markdown) {
  await writeFile(workflowPath, markdown);
  return await service.runOnce();
}
let initial;
try {
  initial = await service.runOnce();
  assert.equal(initial.lastError, null);
  if (initial.telemetry) assert.equal(initial.telemetry.enabled, enabled);
  if (enabled) {
    await mkdir(store.runDir("audit-run", project.projectId), {
      recursive: true,
    });
    // Primary durable append must reach the complete installed Logs pipeline.
    await store.appendRunEvent("audit-run", {
      at: new Date().toISOString(),
      event: "run-failed",
      runId: "audit-run",
      projectId: project.projectId,
      error: "bounded fixture",
    });
    await new Promise((resolve) => setTimeout(resolve, 1100));
  }
  // Warm owner; wall-clock timings cover full serialized reconciliation work,
  // excluding the sleep between samples and the explicit append fixture.
  for (let index = 0; index < 30; index++) {
    const start = performance.now();
    const snapshot = await service.runOnce();
    ticks.push(performance.now() - start);
    assert.equal(snapshot.lastError, null);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (mode === "healthy") {
    const applied = initial.telemetry.applied;
    let snapshot = await update(
      original.replace("enabled: true", "enabled: false")
    );
    console.log("reached: packed pending disable");
    assert.equal(snapshot.telemetry.enabled, true);
    assert.equal(snapshot.telemetry.pending.enabled, false);
    assert.equal(snapshot.telemetry.restartRequired, true);
    assert.deepEqual(snapshot.telemetry.applied, applied);
    const text = cliStatus(false);
    assert.ok(
      text.includes("Applied: enabled") && text.includes("Pending: disabled")
    );
    assert.ok(text.includes("remains active until restart"));
    const pending = cliStatus().telemetry;
    assert.equal(pending.pending.enabled, false);
    assert.equal(pending.restartRequired, true);
    const invalid = await update(
      original.replace("enabled: true", "enabled: invalid")
    );
    console.log("reached: packed invalid reload");
    assert.equal(invalid.workflow.isValid, false);
    assert.equal(invalid.workflow.usedLastKnownGood, true);
    assert.deepEqual(invalid.telemetry.applied, applied);
    assert.deepEqual(invalid.telemetry.pending, pending.pending);
    snapshot = await update(original);
    console.log("reached: packed revert");
    assert.equal(snapshot.telemetry.pending, null);
    assert.equal(snapshot.telemetry.restartRequired, false);
    const changed = await update(
      original.replace(/endpoint: .+/, "endpoint: http://127.0.0.1:1")
    );
    console.log("reached: packed endpoint reload");
    assert.deepEqual(changed.telemetry.applied, applied);
    assert.notDeepEqual(changed.telemetry.pending.signals, applied.signals);
    await update(original);
    assert.equal(cliStatus().telemetry.pending, null);
    console.log(
      "reached: packed pending disable, invalid last-known-good, revert and endpoint reload"
    );
  }
  const snapshot = await service.status();
  assert.equal(JSON.stringify(snapshot).includes("audit-secret"), false);
  console.log(
    "TICK_REPORT=" +
      JSON.stringify({
        mode,
        samples: ticks,
        p95Ms: percentile(ticks),
        telemetry: snapshot.telemetry,
      })
  );
} finally {
  const start = performance.now();
  await service.shutdown();
  console.log("reached: packed shutdown deadline");
  assert.ok(
    performance.now() - start < 5500,
    "Packaged shutdown exceeded its shared deadline"
  );
  await writeFile(workflowPath, original);
}
