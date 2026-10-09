import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const base = dirname(fileURLToPath(import.meta.url));
const cli = join(base, "../packages/cli/dist/index.js");
const { AgentRegistry, createLocalManagementAdapter, resolveCanonicalRuntime } =
  await import(
    pathToFileURL(join(base, "../packages/cli/dist/management-local.js"))
  );
const root = await realpath(
  await mkdtemp(join(tmpdir(), "management-agent-blackbox-"))
);
const folder = join(root, "prepared");
const alias = join(root, "alias");
const configDir = join(root, "cli");
const credential = "management-credential-blackbox-canary";
const environment = {
  ...process.env,
  GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH: join(root, "issues.json"),
  GH_SYMPHONY_AGENT_TOKEN: credential,
  ACCIDENTAL_COPY: credential,
};
const workflow = `---
tracker:
  kind: file
  provider:
    path: $GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH
    project_id: management-blackbox
  active_states: [Ready]
polling:
  interval_ms: 1000
codex:
  command: codex
repository:
  slug: fixture/project
---
PROMPT_PRIVATE_CANARY
`;
let registry;
let reader;
let project;
let target;
const journal = {
  async persistStopTarget(value) {
    target = value;
    const file = await open(join(root, "stop-target.json"), "w", 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    const directory = await open(root, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  },
};
function run(args, selectedConfig = configDir) {
  return spawnSync(
    process.execPath,
    [cli, "--config", selectedConfig, "--json", "project", ...args],
    { env: environment, cwd: folder, encoding: "utf8", timeout: 15000 }
  );
}
async function ownership(runtime) {
  return Promise.all(
    [
      join(
        runtime.configDir,
        "projects",
        runtime.runtimeProjectId,
        "daemon.pid"
      ),
      join(runtime.configDir, "projects", runtime.runtimeProjectId, ".lock"),
      join(folder, ".gh-symphony-start.lock"),
    ].map(async (path) => {
      const record = JSON.parse(
        await readFile(path, "utf8").catch(() => "null")
      );
      if (!record) return null;
      const { heartbeatAt, ...owner } = record;
      return owner;
    })
  );
}
try {
  await mkdir(folder);
  await mkdir(configDir);
  await symlink(folder, alias);
  await writeFile(join(root, "issues.json"), "[]");
  await writeFile(join(folder, "WORKFLOW.md"), workflow);
  registry = await AgentRegistry.open(join(root, "agent"));
  const enrollment = {
    protocolVersion: 1,
    requestId: "66666666-6666-4666-8666-666666666666",
    environmentId: "11111111-1111-4111-8111-111111111111",
    agentId: "55555555-5555-4555-8555-555555555555",
    credential: "enrolled-identity-credential-canary",
  };
  await registry.saveIdentity("https://control.example", enrollment);
  const peer = await AgentRegistry.open(join(root, "peer-agent"));
  try {
    await peer.saveIdentity("https://control.example", {
      ...enrollment,
      environmentId:
        process.env.MANAGEMENT_AGENT_PLANT_FORBIDDEN === "identity"
          ? enrollment.environmentId
          : "22222222-2222-4222-8222-222222222222",
      agentId: "77777777-7777-4777-8777-777777777777",
    });
    const left = await registry.add(alias);
    const right = await peer.add(folder);
    assert.equal(left.localProjectId, right.localProjectId);
    assert.notEqual(
      registry.identity.environmentId,
      peer.identity.environmentId,
      "CP-01 local identities qualify shared folder ID by environment"
    );
  } finally {
    await peer.close();
  }
  project = await registry.add(alias);
  if (process.env.MANAGEMENT_AGENT_PLANT_FORBIDDEN === "canonical") {
    await rm(alias);
    const redirected = join(root, "redirected");
    await mkdir(redirected);
    await symlink(redirected, alias);
  }
  assert.equal(
    (await registry.add(folder)).localProjectId,
    project.localProjectId
  );
  assert.equal(
    await realpath(alias),
    folder,
    "CP-02 registered alias must retain canonical folder"
  );
  await registry.resolveManaged(project.localProjectId);
  await assert.rejects(AgentRegistry.open(join(root, "agent")));
  const invalid = join(root, "invalid");
  await mkdir(invalid);
  const invalidProject = await registry.add(invalid);
  await writeFile(
    join(root, "cli-boundary.mjs"),
    `import { writeFileSync } from "node:fs";\nimport { spawnSync } from "node:child_process";\nwriteFileSync(${JSON.stringify(join(root, "child-environment.json"))}, JSON.stringify(process.env), {mode:0o600});\nconst child = spawnSync(process.execPath, [${JSON.stringify(cli)}, ...process.argv.slice(2)], {env: process.env, stdio:"inherit"});\nprocess.exit(child.status ?? 1);\n`
  );
  const local = createLocalManagementAdapter(registry, {
    configDir,
    executable: process.execPath,
    argumentPrefix: [join(root, "cli-boundary.mjs")],
    environment,
    managementCredentials:
      process.env.MANAGEMENT_AGENT_PLANT_FORBIDDEN === "credential"
        ? []
        : [credential],
    launchContext: { kind: "foreground" },
    timeoutMs: 10000,
    pollIntervalMs: 50,
  });
  reader = local.reader;
  assert.equal(
    (await local.adapter.start(invalidProject.localProjectId)).diagnostic.code,
    "project_invalid"
  );
  await registry.remove(invalidProject.localProjectId);
  const first = run(["start", "--project-dir", alias, "--daemon"]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const runtime = await resolveCanonicalRuntime(configDir, folder);
  const a = await reader.inspect(project);
  assert.equal(a.process.state, "running");
  assert.equal(a.ready, true);
  assert.notEqual(runtime.runtimeProjectId, project.localProjectId);
  const duplicates = await Promise.all([
    local.adapter.start(project.localProjectId),
    local.adapter.start(project.localProjectId),
  ]);
  assert.ok(
    duplicates.every(
      (result) =>
        result.state === "succeeded" && result.process.pid === a.process.pid
    )
  );
  const contender = run(
    ["start", "--project-dir", folder, "--daemon"],
    join(root, "contender")
  );
  assert.notEqual(
    contender.status,
    0,
    "CP-04 local contender must reject existing folder ownership"
  );
  assert.equal((await reader.inspect(project)).process.pid, a.process.pid);
  await writeFile(join(folder, "WORKFLOW.md"), "invalid workflow");
  assert.equal((await reader.inspect(project)).validation.state, "invalid");
  assert.equal(
    (await local.adapter.start(project.localProjectId)).state,
    "failed"
  );
  const stopped = await local.adapter.stop(project.localProjectId, journal);
  assert.equal(stopped.state, "succeeded", JSON.stringify(stopped));
  if (process.env.MANAGEMENT_AGENT_PLANT_FORBIDDEN === "locks")
    await writeFile(
      join(folder, ".gh-symphony-start.lock"),
      JSON.stringify({ pid: 1 })
    );
  assert.equal(
    (await reader.inspect(project)).locksReleased,
    true,
    "CP-03 stop completion requires released locks"
  );
  const saved = JSON.parse(
    await readFile(join(root, "stop-target.json"), "utf8")
  );
  assert.equal(
    (await local.adapter.stop(project.localProjectId, journal, saved)).state,
    "succeeded"
  );
  console.log(
    "CP-01–04 reached: canonical dedup, invalid inventory, exclusive locks, invalid-workflow verified stop and recovery"
  );
  await writeFile(join(folder, "WORKFLOW.md"), workflow);
  const restarted = await Promise.all([
    local.adapter.start(project.localProjectId),
    local.adapter.start(project.localProjectId),
  ]);
  assert.ok(
    restarted.every((result) => result.state === "succeeded"),
    JSON.stringify(restarted)
  );
  const b = await reader.inspect(project);
  assert.equal(restarted[0].process.pid, restarted[1].process.pid);
  assert.equal(b.runtime.runtimeProjectId, runtime.runtimeProjectId);
  assert.notEqual(b.process.identity, a.process.identity);
  const owners = await ownership(runtime);
  const stale = await local.adapter.stop(
    project.localProjectId,
    journal,
    saved
  );
  assert.equal(stale.diagnostic.code, "superseded_target");
  if (process.env.MANAGEMENT_AGENT_PLANT_FORBIDDEN === "replacement")
    await rm(
      join(configDir, "projects", runtime.runtimeProjectId, "daemon.pid")
    );
  assert.deepEqual(
    await ownership(runtime),
    owners,
    "CP-08 replacement ownership must survive recovered stop"
  );
  console.log(
    "CP-08 reached: alias restart retains runtime ID; replacement process and ownership survive stale target"
  );
  const inventory = JSON.stringify(await registry.inventory(reader, "fixture"));
  assert.ok(
    !inventory.includes("PROMPT_PRIVATE_CANARY") &&
      !inventory.includes(b.process.identity),
    "CP-15 inventory excludes prompt and raw OS identity"
  );
  const launchedEnvironment = await readFile(
    join(root, "child-environment.json"),
    "utf8"
  );
  assert.ok(
    !launchedEnvironment.includes(credential),
    "CP-15 management credentials absent from project environment"
  );
  console.log(
    "CP-15 reached: projected inventory and actual project process environment exclude management secrets"
  );
  await registry.remove(project.localProjectId);
  await assert.rejects(local.adapter.start(project.localProjectId));
  await registry.close();
  registry = await AgentRegistry.open(join(root, "agent"));
  if (process.env.MANAGEMENT_AGENT_PLANT_FORBIDDEN === "continuity")
    run(["stop", "--project-dir", folder]);
  assert.equal(
    (await reader.inspect(project)).process.pid,
    b.process.pid,
    "CP-14 removal and agent restart preserve orchestrator"
  );
  console.log(
    "CP-14 reached: allowlist removal and agent registry restart preserve existing orchestrator"
  );
  console.log(
    `management agent contract passed (${process.platform}); native service isolation not exercised`
  );
} finally {
  if (reader && project) {
    const observed = await reader.inspect(project);
    if (observed.process.state === "running") {
      run([
        "stop",
        "--project-dir",
        folder,
        "--expected-pid",
        String(observed.process.pid),
        "--expected-process-identity",
        observed.process.identity,
      ]);
      for (
        let i = 0;
        i < 100 &&
        !(await reader.targetExited({
          pid: observed.process.pid,
          processIdentity: observed.process.identity,
        }));
        i++
      )
        await delay(50);
    }
  }
  await registry?.close();
  await rm(root, { recursive: true, force: true });
}
