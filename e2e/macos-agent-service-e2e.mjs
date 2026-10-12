import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  realpath,
  rm,
} from "node:fs/promises";
import { userInfo, tmpdir, release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
  AgentRegistry,
  MacOSAgentService,
  runLaunchctl,
} from "../packages/cli/dist/management-agent.js";
import { inspectLocalProject } from "../packages/cli/dist/management-local.js";
if (process.platform !== "darwin") {
  console.error(
    "Native LaunchAgent verification requires macOS (not Linux simulation)"
  );
  process.exit(69);
}
const root = await realpath(await mkdtemp(join(tmpdir(), "symphony-c12-")));
const base = dirname(fileURLToPath(import.meta.url));
const cli = join(base, "../packages/cli/dist/index.js");
const dataDirectory = join(root, "agent");
const configDir = join(root, "project-config");
const configPath = join(root, "fixture.json");
const folder = join(root, "project");
const issues = join(root, "issues.json");
const entrypoint = join(base, "fixtures/macos-agent-entrypoint.mts");
const label = `com.github-symphony.c12-${randomUUID()}`;
const portServer = createServer();
await new Promise((resolve) => portServer.listen(0, "127.0.0.1", resolve));
const port = portServer.address().port;
await new Promise((resolve) => portServer.close(resolve));
const forbidden = process.env.MACOS_SERVICE_PLANT_FORBIDDEN;
let service;
let project;
let before;
function check(name, condition) {
  console.log(`reached: ${name}`);
  assert.ok(condition, name);
}
async function waitFor(read, description) {
  for (let i = 0; i < 150; i++) {
    const value = await read();
    if (value) return value;
    await delay(200);
  }
  throw new Error(`Timed out: ${description}`);
}
async function started(previousPid) {
  return waitFor(async () => {
    const value = await readFile(join(root, "started.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    return value && value.agentPid !== previousPid ? value : null;
  }, "agent started project");
}
function group(pid) {
  return execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(pid)], {
    encoding: "utf8",
  }).trim();
}
async function preserved(stage) {
  if (forbidden === "survival" && stage === "stop")
    process.kill(before.process.pid, "SIGTERM");
  await delay(300);
  const observation = await inspectLocalProject(configDir, project, {
    ...process.env,
    GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH: issues,
  });
  check(
    `CP-23 ${stage} preserves actual managed project`,
    observation.ready &&
      observation.process.state === "running" &&
      observation.process.pid === before.process.pid &&
      createHash("sha256")
        .update(observation.process.identity)
        .digest("hex") === before.process.identity
  );
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/state`, {
    headers: { authorization: "Bearer c12-http-fixture" },
  });
  check(
    `CP-23 ${stage} project state endpoint remains responsive`,
    response.ok && typeof (await response.json()).summary === "object"
  );
}
try {
  await mkdir(dataDirectory, { mode: 0o700 });
  await mkdir(folder);
  await writeFile(issues, "[]");
  await writeFile(
    join(folder, "WORKFLOW.md"),
    `---\ntracker:\n  kind: file\n  provider:\n    path: $GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH\n    project_id: c12-native\n  active_states: [Ready]\npolling:\n  interval_ms: 1000\ncodex:\n  command: codex\nrepository:\n  slug: fixture/project\n---\nC12 fixture\n`
  );
  await writeFile(
    configPath,
    JSON.stringify({ dataDirectory, configDir, cli, root, issues, port }),
    { mode: 0o600 }
  );
  const registry = await AgentRegistry.open(dataDirectory);
  await registry.saveIdentity("https://fixture.invalid", {
    protocolVersion: 1,
    requestId: randomUUID(),
    environmentId: randomUUID(),
    agentId: randomUUID(),
    credential: "c12-fixture-no-real-secret",
  });
  project = await registry.add(folder);
  await registry.close();
  const registryBytes = await readFile(join(dataDirectory, "registry.json"));
  await writeFile(join(dataDirectory, "journal-fixture"), "retained journal", {
    mode: 0o600,
  });
  let failBootstrap = true;
  service = new MacOSAgentService(
    {
      home: userInfo().homedir,
      uid: process.getuid(),
      nodePath: process.execPath,
      entrypoint,
      configPath,
      dataDirectory,
      label,
    },
    async (args) => {
      if (args[0] === "bootstrap" && failBootstrap)
        return { code: 5, stdout: "", stderr: "C12 fault injection" };
      return runLaunchctl(args);
    }
  );
  await service.install();
  execFileSync("/usr/bin/plutil", ["-lint", service.plistPath]);
  await assert.rejects(service.start(), /bootstrap/);
  failBootstrap = false;
  await service.install();
  await service.start();
  console.log("Native fixture root:", root, "job:", label);
  let current = await started();
  before = current;
  check(
    "CP-22 saved identity survives failed bootstrap/retry",
    registryBytes.equals(await readFile(join(dataDirectory, "registry.json")))
  );
  check(
    "CP-23 loaded service reports actual PID",
    (await service.status()).pid === current.agentPid && forbidden !== "loaded"
  );
  check(
    "CP-23 project process group is outside agent job",
    group(current.agentPid) !== group(before.process.pid)
  );
  let conflict = false;
  try {
    const second = await AgentRegistry.open(dataDirectory);
    await second.close();
  } catch {
    conflict = true;
  }
  check(
    "CP-23 foreground/service lock conflict rejected",
    conflict && forbidden !== "lock"
  );
  await service.stop();
  check("CP-23 stop actually unloads job", !(await service.status()).loaded);
  await preserved("stop");
  await service.start();
  current = await started(current.agentPid);
  await service.restart();
  current = await started(current.agentPid);
  await preserved("restart");
  const crashedPid = current.agentPid;
  const crashTime = Date.now();
  process.kill(crashedPid, "SIGKILL");
  current = await started(crashedPid);
  check(
    "CP-23 unexpected exit has bounded recovery",
    current.agentPid !== crashedPid &&
      Date.now() - crashTime < 30_000 &&
      forbidden !== "restart"
  );
  await preserved("unexpected-exit");
  await service.uninstall();
  check(
    "CP-23 uninstall removes only definition",
    !(await service.status()).installed && !(await service.status()).loaded
  );
  await preserved("uninstall");
  if (forbidden === "retention")
    await writeFile(join(dataDirectory, "journal-fixture"), "removed");
  check(
    "CP-23 uninstall preserves enrollment allowlist and journal",
    registryBytes.equals(
      await readFile(join(dataDirectory, "registry.json"))
    ) &&
      (await readFile(join(dataDirectory, "journal-fixture"), "utf8")) ===
        "retained journal"
  );
  console.log(
    `C12 native launchd passed: darwin ${release()}; login/logout not exercised`
  );
} finally {
  await service
    ?.uninstall()
    .catch((error) => console.error("Service cleanup:", error.message));
  if (project) {
    try {
      execFileSync(
        process.execPath,
        [
          cli,
          "--config",
          configDir,
          "project",
          "stop",
          "--project-dir",
          folder,
        ],
        {
          env: { ...process.env, GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH: issues },
          stdio: "pipe",
          timeout: 30_000,
        }
      );
    } catch {
      /* Already stopped by a forbidden-condition probe. */
    }
  }
  await rm(root, { recursive: true, force: true });
}
