/** C13 compiled CLI + independent HTTPS/OS peers. No native-service acceptance claim. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:https";
import {
  mkdtemp,
  readFile,
  mkdir,
  realpath,
  rm,
  writeFile,
  stat,
} from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
const cli =
  process.env.C13_CLI ??
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../packages/cli/dist/index.js"
  );
const { AgentRegistry, setupAgent, createNativeAgentService } = await import(
  pathToFileURL(join(dirname(cli), "management-agent.js")).href
);
const root = await realpath(await mkdtemp(join(tmpdir(), "c13-agent-setup-")));
const token = "c13-independent-one-use-fixture";
const credential = "c13-independent-credential-fixture";
const environmentId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const sessionId = "33333333-3333-4333-8333-333333333333";
let enrollments = 0;
let signals = 0;
let transcript = "";
const children = new Set();
const planted = process.env.AGENT_SETUP_PLANT_FORBIDDEN;
function check(name, actual, expected, mutation) {
  console.log(`reached: ${name}`);
  assert.deepEqual(
    planted === mutation
      ? typeof expected === "boolean"
        ? !expected
        : "forbidden"
      : actual,
    expected,
    name
  );
}
function start(args, input = "") {
  const child = spawn(process.execPath, [cli, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.end(input);
  const done = once(child, "close").then(([code]) => {
    children.delete(child);
    transcript += stdout + stderr;
    return { code, stdout, stderr };
  });
  return { child, done };
}
async function run(args, input) {
  return start(args, input).done;
}
async function until(predicate, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(30);
  }
  throw new Error(`Timed out: ${label}`);
}
let server;
try {
  const key = join(root, "key.pem");
  const cert = join(root, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      key,
      "-out",
      cert,
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" }
  );
  server = createServer(
    { key: await readFile(key), cert: await readFile(cert) },
    async (request, response) => {
      try {
        const parts = [];
        for await (const chunk of request) parts.push(chunk);
        const url = new URL(request.url, "https://localhost");
        const data =
          request.method === "GET"
            ? Object.fromEntries(url.searchParams)
            : JSON.parse(Buffer.concat(parts).toString());
        const reply = (value) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(value));
        };
        if (url.pathname === "/api/v1/agents/enroll") {
          assert.equal(data.token, token);
          enrollments++;
          reply({
            protocolVersion: 1,
            requestId: data.requestId,
            environmentId,
            agentId,
            credential,
          });
          return;
        }
        assert.equal(request.headers.authorization, `Bearer ${credential}`);
        const envelope = {
          protocolVersion: 1,
          requestId: data.requestId,
          environmentId,
          sessionId,
        };
        if (url.pathname.endsWith("/sessions"))
          reply({
            ...envelope,
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          });
        else if (url.pathname.endsWith("/observations")) {
          assert.equal(data.inventory.projects.length, 0);
          signals++;
          reply({ ...envelope, receivedAt: new Date().toISOString() });
        } else if (url.pathname.endsWith("/poll")) {
          await delay(100);
          reply({ ...envelope, commands: [], reads: [] });
        } else {
          response.writeHead(404);
          response.end();
        }
      } catch {
        response.writeHead(400);
        response.end("independent peer rejected input");
      }
    }
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `https://127.0.0.1:${server.address().port}`;
  const directory = join(root, "agent");
  await mkdir(directory, { mode: 0o700 });
  const configPath = join(directory, "config.json");
  const config = {
    version: 1,
    dataDirectory: directory,
    projectConfigDir: join(root, "projects"),
    nodePath: process.execPath,
    cliPath: cli,
    caFile: cert,
  };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const flags = ["--agent-config", configPath];
  check(
    "shared install help and version",
    (await run(["agent", "setup", "--help"])).stdout.includes(
      "--token-stdin"
    ) && (await run(["--version"])).stdout.includes("gh-symphony"),
    true,
    "help"
  );
  const first = await run(
    ["agent", "enroll", "--server", origin, "--token-stdin", ...flags],
    `${token}\n`
  );
  assert.equal(first.code, 0, first.stderr);
  const saved = await readFile(join(directory, "registry.json"), "utf8");
  const retry = await run(["agent", "enroll", "--server", origin, ...flags]);
  check(
    "CP-22 saved enrollment resumes without token input",
    retry.code === 0 && enrollments === 1 && retry.stdout.includes("resumed"),
    true,
    "resume"
  );
  const mismatch = await run([
    "agent",
    "enroll",
    "--server",
    "https://other.invalid",
    ...flags,
  ]);
  check(
    "CP-22 conflicting server preserves identity",
    mismatch.code !== 0 &&
      (await readFile(join(directory, "registry.json"), "utf8")) === saved,
    true,
    "identity"
  );
  check(
    "private identity permissions",
    (await stat(join(directory, "registry.json"))).mode & 0o777,
    0o600,
    "permissions"
  );
  const rejected = await run([
    "agent",
    "enroll",
    "--server",
    origin,
    "--token",
    token,
    ...flags,
  ]);
  assert.notEqual(rejected.code, 0);
  const agent = start(["agent", "run", ...flags]);
  await until(() => signals > 0, "first signal");
  check(
    "CP-21 empty host sends authenticated first signal",
    signals > 0,
    true,
    "signal"
  );
  const conflict = await run(["agent", "run", ...flags]);
  check(
    "CP-23 conflicting foreground process is rejected",
    conflict.code !== 0 && /lock|already|owner/i.test(conflict.stderr),
    true,
    "lock"
  );
  agent.child.kill("SIGTERM");
  await agent.done;
  let registry = await AgentRegistry.open(directory);
  await registry.close();
  const folder = join(root, "prepared");
  await mkdir(folder);
  const add = await run([
    "agent",
    "project",
    "add",
    folder,
    ...flags,
    "--json",
  ]);
  assert.equal(add.code, 0, add.stderr);
  const project = JSON.parse(add.stdout);
  const list = await run(["agent", "project", "list", ...flags, "--json"]);
  check(
    "existing folder allowlist is routed through shared CLI",
    JSON.parse(list.stdout),
    [project],
    "allowlist"
  );
  await run(["agent", "project", "remove", project.localProjectId, ...flags]);
  registry = await AgentRegistry.open(directory);
  assert.equal(registry.list().length, 0);
  await registry.close();

  // Independently supplied OS-command peer; exercise real native adapters without
  // touching the operator's service definitions. Startup acquires the actual lock.
  for (const os of ["linux", "darwin"]) {
    const home = join(root, os);
    await mkdir(home, { mode: 0o700 });
    let failed = false;
    let loaded = false;
    let starts = 0;
    const plist = join(
      home,
      "Library/LaunchAgents/com.github-symphony.management-agent.plist"
    );
    const startPeer = async () => {
      const owner = await AgentRegistry.open(directory);
      await owner.close();
      starts++;
    };
    const service = createNativeAgentService(config, configPath, {
      platform: os,
      home,
      linux: {
        platform: "linux",
        readSelfCgroup: async () => "0::/user.slice/agent.service\n",
        runner: async ({ args }) => {
          if (args.includes("--version"))
            return { exitCode: 0, stdout: "systemd 254\n" };
          if (args.includes("show-environment"))
            return { exitCode: 0, stdout: "{}" };
          if (args.includes("show-user"))
            return { exitCode: 0, stdout: "no\n" };
          if (args.includes("show"))
            return {
              exitCode: 0,
              stdout: `LoadState=loaded\nActiveState=active\nFragmentPath=${join(home, ".config/systemd/user/gh-symphony-agent.service")}\nDropInPaths=\nTransient=no\n`,
            };
          if (args.includes("daemon-reload") && !failed) {
            failed = true;
            return { exitCode: 1, stdout: "injected installation failure" };
          }
          if (args.includes("start")) await startPeer();
          return { exitCode: 0, stdout: "" };
        },
      },
      launchctl: async (args) => {
        if (args[0] === "print" && args[1] === `gui/${process.getuid()}`)
          return { code: 0, stdout: "", stderr: "" };
        if (args[0] === "print")
          return {
            code: loaded ? 0 : 113,
            stdout: loaded ? `path = ${plist}\n` : "",
            stderr: "",
          };
        if (args[0] === "bootstrap") {
          if (!failed) {
            failed = true;
            return {
              code: 1,
              stdout: "",
              stderr: "injected installation failure",
            };
          }
          await startPeer();
          loaded = true;
        }
        if (args[0] === "bootout") loaded = false;
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    const options = {
      directory,
      serverOrigin: origin,
      service,
      client: {
        enroll() {
          throw new Error("must resume saved enrollment");
        },
      },
      readToken() {
        throw new Error("must not prompt");
      },
      report() {},
    };
    await assert.rejects(setupAgent(options), /failed/);
    await setupAgent(options);
    check(
      `CP-22 ${os} partial service setup resumes after lock release`,
      starts === 1,
      true,
      os
    );
    await service.status();
    await service.stop();
    await service.restart();
    await service.uninstall();
    assert.equal(
      await readFile(join(directory, "registry.json"), "utf8"),
      saved
    );
  }
  check(
    "token and credential absent from CLI diagnostics",
    !transcript.includes(token) && !transcript.includes(credential),
    true,
    "secret"
  );
  console.log(
    `C13 pass: actual host ${platform()}; Linux/macOS OS-command simulations, no native service installation`
  );
} finally {
  for (const child of children) child.kill("SIGKILL");
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  await rm(root, { recursive: true, force: true });
}
