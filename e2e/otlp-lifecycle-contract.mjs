import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  OrchestratorService,
  createStore,
} from "../packages/orchestrator/dist/index.js";
import { createProjectPipeline } from "../packages/orchestrator/dist/observability/pipeline.js";
import { startControlPlaneServer } from "../packages/control-plane/dist/index.js";

const probe = process.argv.find((arg) => arg.startsWith("--probe="))?.slice(8);
const reached = (name) => console.log(`reached: ${name}`);
const execute = promisify(execFile);
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
  process.env.OTEL_SERVICE_NAME = "CANARY_AMBIENT";
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
  for (const value of [
    undefined,
    "service.instance.id=CANARY_AMBIENT",
    "",
    "a=CANARY_AMBIENT,",
    "symphony.max_token=CANARY_AMBIENT",
    Array.from({ length: 20 }, (_, i) => `k8s.key${i}=safe`).join(","),
  ]) {
    if (value === undefined) delete process.env.OTEL_RESOURCE_ATTRIBUTES;
    else process.env.OTEL_RESOURCE_ATTRIBUTES = value;
    await service.runOnce();
    const state = await readStatus();
    reached("ambient resource reload");
    if (probe === "ambient-resource") state.telemetry.enabled = false;
    assert.equal(state.telemetry.enabled, true);
    assert.equal(state.workflow.usedLastKnownGood, false);
    const descriptor = state.telemetry.pending ?? state.telemetry.applied;
    assert.ok(
      descriptor.discardedEnvironmentResources.some(
        ({ key, reason }) =>
          key === "service.name" && reason === "reserved identity"
      )
    );
    if (value !== undefined)
      assert.ok(descriptor.discardedEnvironmentResources.length > 1);
    assert.equal(JSON.stringify(state).includes("CANARY_AMBIENT"), false);
  }
  delete process.env.OTEL_SERVICE_NAME;
  delete process.env.OTEL_RESOURCE_ATTRIBUTES;
  await service.runOnce();
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
  const cliProject = join(root, "cli-project");
  const cliConfig = join(root, "cli-config");
  await mkdir(join(cliProject, "hooks"), { recursive: true });
  await writeFile(
    join(cliProject, "hooks/after_create.sh"),
    "#!/bin/sh\nexit 0\n",
    { mode: 0o755 }
  );
  await execute("git", ["init", cliProject]);
  await writeFile(
    join(cliProject, "WORKFLOW.md"),
    `---\ntracker:\n  kind: file\n  provider:\n    project_slug: o/r\n    path: ${issues}\nrepository:\n  slug: o/r\n  clone_url: file://${cliProject}\nhooks:\n  after_create: hooks/after_create.sh\nworkspace:\n  root: ${join(cliProject, "work")}\nobservability:\n  otlp:\n    enabled: true\n    endpoint: ${endpoint}\n    headers:\n      Authorization: $H_CONTRACT_AUTH\n---\nWork.\n`
  );
  const cli = fileURLToPath(
    new URL("../packages/cli/dist/index.js", import.meta.url)
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("SYMPHONY_") && !key.startsWith("OTEL_")
    )
  );
  env.OTEL_SERVICE_NAME = "CANARY_AMBIENT";
  const started = await execute(
    process.execPath,
    [
      cli,
      "--config",
      cliConfig,
      "project",
      "start",
      "--once",
      "--project-dir",
      cliProject,
    ],
    { env, timeout: 15000 }
  );
  const queried = await execute(
    process.execPath,
    [
      cli,
      "--config",
      cliConfig,
      "--json",
      "project",
      "status",
      "--project-dir",
      cliProject,
    ],
    { env, timeout: 15000 }
  );
  const cliStatus = JSON.parse(queried.stdout);
  if (probe === "cli-capability") cliStatus.telemetry.enabled = false;
  reached("CLI production capability");
  assert.equal(cliStatus.telemetry.enabled, true);
  assert.equal(cliStatus.telemetry.applied.enabled, true);
  assert.equal(cliStatus.lastError, null);
  assert.equal(
    JSON.stringify([cliStatus, started.stdout, started.stderr]).includes(
      "secret-project-auth"
    ),
    false
  );
  const doctorWorkflow = join(cliProject, "WORKFLOW.md");
  for (const json of [false, true]) {
    await writeFile(
      doctorWorkflow,
      `---\ntracker:\n  kind: file\n  provider:\n    path: ${issues}\nobservability:\n  otlp:\n    enabled: true\n    endpoint: $DOCTOR_ENDPOINT\n    headers:\n      Authorization: $H_CONTRACT_AUTH\n---\nWork.\n`
    );
    let diagnostic;
    try {
      diagnostic = await execute(
        process.execPath,
        [cli, "--config", cliConfig, ...(json ? ["--json"] : []), "doctor"],
        {
          cwd: cliProject,
          env: {
            ...env,
            DOCTOR_ENDPOINT:
              "http://endpoint-user:endpoint-password@localhost:4318",
          },
          timeout: 15000,
        }
      );
    } catch (error) {
      if (error.code !== 1) throw error;
      diagnostic = error;
    }
    let output = diagnostic.stdout + diagnostic.stderr;
    if (probe === "doctor-secret") output += "endpoint-password";
    if (probe === "doctor-reason")
      output = output.replaceAll(
        "valid HTTP(S) OTLP endpoint",
        "invalid configuration"
      );
    reached(`doctor safe reason json=${json}`);
    assert.match(output, /valid HTTP\(S\) OTLP endpoint/);
    assert.doesNotMatch(
      output,
      /endpoint-user|endpoint-password|secret-project-auth/
    );
  }
  for (const json of [false, true]) {
    await writeFile(
      doctorWorkflow,
      `---\ntracker:\n  kind: file\n  provider:\n    path: ${issues}\nobservability:\n  otlp:\n    enabled: true\n    endpoint: ${endpoint}\n---\nWork.\n`
    );
    let diagnostic;
    try {
      diagnostic = await execute(
        process.execPath,
        [cli, "--config", cliConfig, ...(json ? ["--json"] : []), "doctor"],
        { cwd: cliProject, env, timeout: 15000 }
      );
    } catch (error) {
      if (error.code !== 1) throw error;
      diagnostic = error;
    }
    let output = diagnostic.stdout + diagnostic.stderr;
    if (probe === "ambient-doctor")
      output = output.replaceAll("service.name", "removed");
    reached(`doctor ambient discard json=${json}`);
    assert.match(output, /service.name/);
    assert.match(output, /reserved identity/);
    assert.doesNotMatch(output, /CANARY_AMBIENT/);
  }
  console.log("OTLP H/I lifecycle contract passed");
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
