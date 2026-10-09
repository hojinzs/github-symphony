import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const base = dirname(fileURLToPath(import.meta.url));
const cli = join(base, "../packages/cli/dist/index.js");
const { AgentRegistry, createLocalReadAdapter, resolveCanonicalRuntime } =
  await import(
    pathToFileURL(join(base, "../packages/cli/dist/management-local.js"))
  );
const { createStore } = await import(
  pathToFileURL(join(base, "../packages/orchestrator/dist/index.js"))
);
const root = await realpath(
  await mkdtemp(join(tmpdir(), "bounded-read-blackbox-"))
);
const folder = join(root, "prepared");
const alias = join(root, "alias");
const configDir = join(root, "cli");
const canary = "PRIVATE_MANAGEMENT_READ_CANARY";
const probe = process.env.BOUNDED_READ_PLANT_FORBIDDEN;
let registry;
let started = false;
function command(args) {
  return spawnSync(
    process.execPath,
    [cli, "--config", configDir, "--json", "project", ...args],
    {
      cwd: folder,
      env: {
        ...process.env,
        GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH: join(root, "issues.json"),
      },
      encoding: "utf8",
      timeout: 20_000,
    }
  );
}
let project;
let adapter;
function request(selection) {
  return {
    readId: randomUUID(),
    projectId: randomUUID(),
    sessionId: randomUUID(),
    localProjectId: project.localProjectId,
    submittedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    selection,
  };
}
function log(stream = "worker", cursor) {
  return {
    kind: "log-chunk",
    runId: "run-000",
    stream,
    maxBytes: 256 * 1024,
    ...(cursor ? { cursor } : {}),
  };
}
async function payload(selection) {
  const result = await adapter.read(request(selection));
  assert.equal(result.state, "completed", JSON.stringify(result));
  return result.payload;
}
try {
  await mkdir(folder);
  await mkdir(configDir);
  await symlink(folder, alias);
  await writeFile(join(root, "issues.json"), "[]");
  await writeFile(
    join(folder, "WORKFLOW.md"),
    `---
tracker:
  kind: file
  provider:
    path: $GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH
    project_id: bounded-read-blackbox
  active_states: [Ready]
polling:
  interval_ms: 1000
codex:
  command: codex
repository:
  slug: fixture/project
---
${canary}
`
  );
  const start = command(["start", "--project-dir", alias, "--daemon"]);
  assert.equal(start.status, 0, start.stdout + start.stderr);
  started = true;
  registry = await AgentRegistry.open(join(root, "agent"));
  project = await registry.add(folder);
  const runtime = await resolveCanonicalRuntime(
    configDir,
    project.canonicalPath
  );
  assert.ok(runtime);
  const store = createStore(runtime.configDir);
  const runtimeDirectory = join(
    runtime.configDir,
    "projects",
    runtime.runtimeProjectId
  );
  for (let index = 0; index < 105; index++) {
    const timestamp = new Date(Date.now() - index * 1000).toISOString();
    // Independent persisted-store contract fixture; no adapter methods mocked.
    await store.saveRun({
      runId: `run-${String(index).padStart(3, "0")}`,
      projectId: runtime.runtimeProjectId,
      projectSlug: "fixture",
      issueId: `issue-${index}`,
      issueSubjectId: `issue-${index}`,
      issueIdentifier: `fixture/project#${index + 1}`,
      issueState: "Ready",
      repository: { owner: "fixture", name: "project", cloneUrl: "unused" },
      status: "succeeded",
      attempt: 1,
      processId: null,
      port: null,
      workingDirectory: folder,
      issueWorkspaceKey: null,
      workspaceRuntimeDir: folder,
      workflowPath: join(folder, "WORKFLOW.md"),
      retryKind: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: null,
      completedAt: timestamp,
      lastError: canary,
      nextRetryAt: null,
      issueTitle: canary,
    });
  }
  adapter = createLocalReadAdapter(registry, configDir);
  const history = await payload({ kind: "runs", limit: 100 });
  assert.equal(history.runs.length, 100, "CP-12 history limited to 100");
  assert.equal(history.runs[0].runId, "run-000");
  const detail = await payload({ kind: "run-detail", runId: "run-000" });
  if (probe === "metadata") detail.detail.credential = canary;
  assert.ok(
    !JSON.stringify({ history, detail }).includes(canary),
    "CP-15 metadata excludes management credentials and raw errors"
  );
  const worker = join(runtimeDirectory, "runs", "run-000", "worker.log");
  const events = join(runtimeDirectory, "runs", "run-000", "events.ndjson");
  await writeFile(worker, "a".repeat(256 * 1024 + 5));
  await writeFile(events, '{"event":"fixture"}\n');
  const first = await payload(log());
  if (probe === "chunk") first.text += "forbidden";
  assert.equal(
    Buffer.byteLength(first.text),
    256 * 1024,
    "CP-12 log wire text limited to 256 KiB"
  );
  assert.equal(first.eof, false);
  const second = await payload(log("worker", first.cursor));
  assert.equal(second.text, "aaaaa");
  assert.equal(second.eof, true);
  await appendFile(worker, "appended");
  assert.equal((await payload(log("worker", second.cursor))).text, "appended");
  assert.equal((await payload(log("events"))).text, '{"event":"fixture"}\n');
  assert.equal((await payload(log("orchestrator"))).kind, "log-chunk");
  assert.equal(
    (await adapter.read(request({ ...log(), stream: "arbitrary" }))).state,
    "unavailable"
  );
  assert.equal(
    (await adapter.read(request(log("events", first.cursor)))).state,
    "unavailable"
  );
  await rename(worker, worker + ".old");
  await writeFile(worker, "rotated");
  const rotation = await payload(log("worker", second.cursor));
  if (probe === "reset") rotation.reset = false;
  assert.equal(rotation.reset, true, "CP-12 rotation returns explicit reset");
  assert.equal(rotation.text, "rotated");
  await writeFile(worker, "x");
  const truncation = await payload(log("worker", rotation.cursor));
  assert.equal(truncation.reset, true);
  assert.equal(truncation.text, "x");
  await rm(worker);
  let missing = await adapter.read(request(log()));
  if (probe === "missing")
    missing = { state: "completed", payload: { text: "" } };
  assert.equal(
    missing.state,
    "unavailable",
    "CP-12 missing log never reports empty success"
  );
  await writeFile(join(root, "outside"), canary);
  await symlink(join(root, "outside"), worker);
  let escaped = await adapter.read(request(log()));
  if (probe === "containment")
    escaped = { state: "completed", payload: { text: canary } };
  assert.equal(escaped.state, "unavailable", "CP-12 symlink escape rejected");
  assert.ok(!JSON.stringify(escaped).includes(canary));
  for (const runId of ["../outside", "/outside", "unknown-run"])
    assert.equal(
      (await adapter.read(request({ kind: "run-detail", runId }))).state,
      "unavailable"
    );
  const expired = request(log());
  expired.submittedAt = new Date(Date.now() - 2000).toISOString();
  expired.expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.equal((await adapter.read(expired)).state, "expired");
  await writeFile(join(folder, "WORKFLOW.md"), "invalid workflow");
  assert.equal((await payload({ kind: "runs", limit: 1 })).runs.length, 1);
  // Reads are independent of workflow validity, lifecycle command slots and process effects.
  const ownershipBefore = JSON.parse(
    await readFile(join(runtimeDirectory, "daemon.pid"), "utf8")
  );
  await payload({ kind: "run-detail", runId: "run-000" });
  const ownershipAfter = JSON.parse(
    await readFile(join(runtimeDirectory, "daemon.pid"), "utf8")
  );
  assert.equal(ownershipAfter.pid, ownershipBefore.pid);
  assert.equal(ownershipAfter.processIdentity, ownershipBefore.processIdentity);
  await registry.remove(project.localProjectId);
  assert.equal(
    (await adapter.read(request({ kind: "runs", limit: 1 }))).diagnostic.code,
    "project_unmanaged"
  );
  console.log(
    `bounded-read CP-12/15 blackbox passed (${process.platform}); retained fixtures, real CLI/store, no native-service claims`
  );
} finally {
  if (registry) await registry.close();
  if (started) {
    const stop = command(["stop", "--project-dir", folder]);
    assert.equal(stop.status, 0, stop.stdout + stop.stderr);
  }
  await rm(root, { recursive: true, force: true });
}
