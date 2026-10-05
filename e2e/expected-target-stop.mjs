import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const cli = resolve(
  process.env.EXPECTED_STOP_CLI ??
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../packages/cli/dist/index.js"
    )
);
const root = await mkdtemp(join(tmpdir(), "expected-stop-blackbox-"));
const projectDir = join(root, "project");
const configDir = join(root, "config");
const fixture = join(root, "issues.json");
const children = [];
let socketPath;
const env = {
  PATH: process.env.PATH,
  HOME: root,
  GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH: fixture,
  GH_SYMPHONY_HTTP_TOKEN: "local-blackbox-fixture-token",
};

async function poll(check, label) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}

function cliRun(args, expectedCode = 0, selectedFolder = projectDir) {
  const result = spawnSync(
    process.execPath,
    [
      cli,
      "--config",
      configDir,
      "--json",
      "project",
      ...args,
      "--project-dir",
      selectedFolder,
    ],
    { env, cwd: projectDir, encoding: "utf8", timeout: 10_000 }
  );
  assert.equal(
    result.status,
    expectedCode,
    `${args.join(" ")}: ${result.stdout}\n${result.stderr}`
  );
  return result.stdout.trim();
}

async function start() {
  let output = "";
  const child = spawn(
    process.execPath,
    [
      cli,
      "--config",
      configDir,
      "project",
      "start",
      "--project-dir",
      projectDir,
    ],
    { env, cwd: projectDir, stdio: ["ignore", "pipe", "pipe"] }
  );
  children.push(child);
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  await poll(() => {
    assert.equal(child.exitCode, null, output);
    return output.includes("Press Ctrl+C to stop");
  }, "orchestrator readiness");
  return child;
}

function rawStop(target) {
  return new Promise((resolveResponse, reject) => {
    const socket = createConnection(socketPath);
    socket.setTimeout(5_000, () => {
      socket.destroy();
      reject(new Error("socket timeout"));
    });
    socket.setEncoding("utf8");
    socket.on("error", reject);
    socket.on("connect", () => socket.write(`${JSON.stringify(target)}\n`));
    let response = "";
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("end", () => resolveResponse(response.trim()));
  });
}

try {
  await mkdir(projectDir);
  await mkdir(configDir);
  await writeFile(fixture, "[]\n");
  await writeFile(
    join(projectDir, "WORKFLOW.md"),
    `---
tracker:
  kind: file
  provider:
    path: $GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH
    project_id: expected-stop-blackbox
  active_states: [Ready]
polling:
  interval_ms: 1000
codex:
  command: codex
repository:
  slug: test-owner/test-repo
---
Expected-target stop black-box fixture.
`
  );
  const a = await start();
  const projectId = `project-${createHash("sha256").update(projectDir).digest("hex").slice(0, 8)}`;
  const runtimeDir = join(configDir, "projects", projectId);
  const paths = [
    join(runtimeDir, "daemon.pid"),
    join(runtimeDir, ".lock"),
    join(projectDir, ".gh-symphony-start.lock"),
  ];
  const lockA = JSON.parse(await readFile(paths[1], "utf8"));
  assert.equal(lockA.pid, a.pid);
  assert.ok(
    lockA.processIdentity,
    "OS process identity must be available (ps required)"
  );
  assert.match(
    lockA.processIdentity,
    /gh-symphony [0-9a-f-]{36} repo start/,
    "OS identity must include a process-lifetime nonce"
  );
  const targetA = { pid: a.pid, processIdentity: lockA.processIdentity };
  const expectedArgs = [
    "--expected-pid",
    String(targetA.pid),
    "--expected-process-identity",
    targetA.processIdentity,
  ];
  const daemonRecord = (lock) =>
    JSON.stringify({
      pid: lock.pid,
      startedAt: lock.startedAt,
      processIdentity: lock.processIdentity,
      cwd: projectDir,
    });
  // Daemon-record boundary populated from real CLI-owned lock/OS evidence.
  // Foreground children are reaped by this runner on both platforms.
  await writeFile(paths[0], daemonRecord(lockA));
  const key = createHash("sha256")
    .update(await realpath(configDir))
    .update("\0")
    .update(projectId)
    .digest("hex")
    .slice(0, 32);
  socketPath = `/tmp/gh-symphony-stop-${process.getuid()}/${key}.sock`;
  for (const args of [
    ["--expected-pid", String(a.pid)],
    [...expectedArgs, "--force"],
  ])
    cliRun(["stop", ...args], 2);
  const pidA = await readFile(paths[0], "utf8");
  await writeFile(
    paths[0],
    JSON.stringify({ ...JSON.parse(pidA), processIdentity: null })
  );
  assert.equal(
    JSON.parse(cliRun(["stop", ...expectedArgs], 1)).outcome,
    "process_unverified"
  );
  assert.equal(a.exitCode, null);
  await writeFile(paths[0], pidA);

  const otherFolder = join(root, "other-project");
  await mkdir(otherFolder);
  const otherId = `other-project-${createHash("sha256").update(otherFolder).digest("hex").slice(0, 8)}`;
  const otherRuntime = join(configDir, "projects", otherId);
  await mkdir(otherRuntime);
  // A cached entry under another folder's key must not redirect stop to A.
  await writeFile(
    join(otherRuntime, "project.json"),
    await readFile(join(runtimeDir, "project.json"))
  );
  assert.equal(
    JSON.parse(cliRun(["stop", ...expectedArgs], 1, otherFolder)).outcome,
    "process_unverified"
  );
  assert.equal(a.exitCode, null);
  assert.equal(await readFile(paths[0], "utf8"), pidA);

  const savedWorkflow = await readFile(join(projectDir, "WORKFLOW.md"), "utf8");
  await writeFile(join(projectDir, "WORKFLOW.md"), "invalid workflow");
  assert.equal(
    JSON.parse(cliRun(["stop", ...expectedArgs])).outcome,
    "signal_sent"
  );
  await poll(() => a.exitCode !== null, "A graceful exit");
  await poll(
    async () =>
      (
        await Promise.all(
          paths.slice(1).map((path) =>
            readFile(path).then(
              () => false,
              (error) => error.code === "ENOENT"
            )
          )
        )
      ).every(Boolean),
    "A locks released"
  );
  assert.equal(
    JSON.parse(cliRun(["stop", ...expectedArgs])).outcome,
    "already_stopped"
  );
  assert.equal(await readFile(paths[0], "utf8"), pidA);

  await writeFile(join(projectDir, "WORKFLOW.md"), savedWorkflow);
  const b = await start();
  const lockB = JSON.parse(await readFile(paths[1], "utf8"));
  await writeFile(paths[0], daemonRecord(lockB));
  const before = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  const owners = before.map((raw) => {
    const { heartbeatAt: _heartbeatAt, ...owner } = JSON.parse(raw);
    return owner;
  });
  assert.equal(
    JSON.parse(cliRun(["stop", ...expectedArgs], 1)).outcome,
    "superseded_target"
  );
  assert.equal(
    await rawStop(targetA),
    "superseded_target",
    "connection to B must reject A after caller-side verification"
  );
  const reusedPidArgs = [
    "--expected-pid",
    String(b.pid),
    "--expected-process-identity",
    targetA.processIdentity,
  ];
  assert.equal(
    JSON.parse(cliRun(["stop", ...reusedPidArgs], 1)).outcome,
    "superseded_target",
    "same PID with old identity must be rejected"
  );
  if (process.env.EXPECTED_STOP_PLANT_FORBIDDEN === "1") await rm(paths[0]);
  assert.equal(b.exitCode, null, "replacement B must remain alive");
  process.kill(b.pid, 0);
  const after = await Promise.all(
    paths.map((path) => readFile(path, "utf8").catch(() => "null"))
  );
  assert.deepEqual(
    after.map((raw) => {
      const parsed = JSON.parse(raw);
      if (!parsed) return null;
      const { heartbeatAt: _heartbeatAt, ...owner } = parsed;
      return owner;
    }),
    owners,
    "CP-08: replacement B ownership records must be preserved"
  );
  console.log(
    "CP-08 reached: replacement B alive; all PID/lock ownership records preserved; stale identity rejected"
  );
  await writeFile(join(projectDir, "WORKFLOW.md"), "invalid workflow");
  cliRun(["stop"]);
  await poll(() => b.exitCode !== null, "B legacy graceful exit");
  console.log(`expected-target stop blackbox passed (${process.platform})`);
} finally {
  for (const child of children) {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await Promise.race([exited, delay(5_000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  }
  if (socketPath) await rm(socketPath, { force: true });
  await rm(root, { recursive: true, force: true });
}
