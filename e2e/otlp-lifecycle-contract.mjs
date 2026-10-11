import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import {
  OrchestratorService,
  createStore,
} from "../packages/orchestrator/dist/index.js";
import { createProjectPipeline } from "../packages/orchestrator/dist/observability/pipeline.js";
import { startControlPlaneServer } from "../packages/control-plane/dist/index.js";

const probe = process.argv.find((arg) => arg.startsWith("--probe="))?.slice(8);
const reached = (name) => console.log(`reached: ${name}`);
const root = await mkdtemp(join(tmpdir(), "otlp-h-contract-"));
const collector = createServer((_request, response) => {
  response.writeHead(400);
  response.end("Bearer secret-receiver-echo");
});
await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${collector.address().port}`;
const issues = join(root, "issues.json");
const workflow = join(root, "WORKFLOW.md");
const project = {
  projectId: "p",
  slug: "o/r",
  projectDir: root,
  workspaceDir: join(root, "work"),
  repository: { owner: "o", name: "r", cloneUrl: join(root, "repo") },
  tracker: {
    adapter: "file",
    bindingId: "file",
    settings: { issuesPath: issues },
  },
  workflowSource: { type: "external", path: workflow },
};
const store = createStore(join(root, "runtime"));
const warnings = [];
let service;
let api;
let constructions = 0;
const update = (enabled, destination = endpoint) =>
  writeFile(
    workflow,
    `---\ntracker:\n  kind: file\n  provider:\n    path: ${issues}\nworkspace:\n  root: ${project.workspaceDir}\nobservability:\n  otlp:\n    enabled: ${enabled}\n    endpoint: ${destination}\n    headers:\n      Authorization: $H_CONTRACT_AUTH\n---\nWork on {{issue.identifier}}.\n`
  );
process.env.H_CONTRACT_AUTH = "Bearer secret-project-auth";
try {
  await writeFile(issues, "[]");
  await store.saveProjectConfig(project);
  await update(true);
  const gated = new OrchestratorService(store, project);
  reached("production gate");
  await assert.rejects(gated.run({ once: true }), /unsupported/);
  await gated.shutdown();
  await update(false);
  const disabled = new OrchestratorService(store, project, {
    telemetry: {
      createPipeline: async () => {
        constructions++;
        throw new Error("disabled constructor reached");
      },
    },
  });
  const disabledStatus = await disabled.runOnce();
  reached("disabled graph");
  assert.equal(disabledStatus.telemetry.state, "disabled");
  assert.equal(constructions, 0);
  await disabled.shutdown();
  await update(true);
  service = new OrchestratorService(store, project, {
    stderr: { write: (message) => warnings.push(message) },
    telemetry: {
      createPipeline: async (config) => {
        constructions++;
        return createProjectPipeline(
          {
            version: "contract",
            projectId: "p",
            projectSlug: "o/r",
            trackerKind: "file",
          },
          config,
          {
            logs: { diagnostic: (notice) => warnings.push(notice) },
            metrics: { diagnostic: (notice) => warnings.push(notice) },
          }
        );
      },
    },
  });
  await service.runOnce();
  api = await startControlPlaneServer({
    host: "127.0.0.1",
    port: 0,
    runtimeRoot: store.projectDir("p"),
    apiToken: "contract-auth",
  });
  const readStatus = async () => {
    const response = await fetch(`${api.url}/api/v1/state`, {
      headers: { Authorization: "Bearer contract-auth" },
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  await mkdir(store.runDir("r", "p"), { recursive: true });
  await store.appendRunEvent("r", {
    at: new Date().toISOString(),
    event: "run-failed",
    projectId: "p",
    runId: "r",
    error: "safe",
  });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await update(false);
  await service.runOnce();
  if (probe === "pending-disable") {
    // Plant an incorrect committed projection through the same persistence and
    // HTTP boundary, independent of private initialization state.
    const status = await service.status();
    status.telemetry.enabled = false;
    await store.saveProjectStatus({ ...status, projectId: "p" });
  }
  const pending = await readStatus();
  reached("pending disable");
  assert.equal(pending.telemetry.enabled, true);
  assert.equal(pending.telemetry.pending.enabled, false);
  assert.equal(pending.telemetry.restartRequired, true);
  assert.equal(constructions, 1);
  reached("exporter health isolation");
  assert.equal(pending.lastError, null);
  assert.equal(pending.telemetry.state, "degraded");
  assert.equal(pending.telemetry.signals.logs.dropped.permanent, 1);
  await update(true, "https://user:secret-invalid@collector.example");
  await service.runOnce();
  const invalid = await readStatus();
  reached("invalid reload");
  assert.equal(invalid.workflow.usedLastKnownGood, true);
  assert.deepEqual(invalid.telemetry, pending.telemetry);
  await update(true);
  await service.runOnce();
  if (probe === "secret-diagnostic") {
    const status = await service.status();
    status.telemetry.pending = { forbidden: "secret-project-auth" };
    await store.saveProjectStatus({ ...status, projectId: "p" });
  }
  const reverted = await readStatus();
  reached("secret-free output");
  const output = JSON.stringify([reverted, warnings]);
  for (const secret of [
    "secret-project-auth",
    "secret-receiver-echo",
    "secret-invalid",
  ])
    assert.equal(output.includes(secret), false);
  reached("revert");
  assert.equal(reverted.telemetry.restartRequired, false);
  assert.equal(reverted.telemetry.pending, null);
  const start = performance.now();
  await service.shutdown();
  reached("bounded shutdown");
  assert.ok(performance.now() - start <= 5100);
  console.log("OTLP H lifecycle contract passed");
} finally {
  await service?.shutdown();
  if (api) {
    api.server.closeAllConnections();
    await new Promise((resolve) => api.server.close(resolve));
  }
  collector.closeAllConnections();
  await new Promise((resolve) => collector.close(resolve));
  delete process.env.H_CONTRACT_AUTH;
  await rm(root, { recursive: true, force: true });
}
