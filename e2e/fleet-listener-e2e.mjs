/** C23: actual built CLI, production listener, SQLite and agent transport. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  mkdtempSync,
  realpathSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  chmodSync,
  existsSync,
  rmSync,
} from "node:fs";
import {
  request as httpsRequest,
  createServer as createHttpsServer,
} from "node:https";
import { request as httpRequest } from "node:http";
import { createServer as createTcpServer, connect } from "node:net";
import { platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const cli = resolve(
  process.env.C23_CLI ??
    fileURLToPath(new URL("../packages/cli/dist/index.js", import.meta.url))
);
const peer = fileURLToPath(
  new URL("./fleet-listener-os-peer.mjs", import.meta.url)
);
const root = realpathSync(mkdtempSync(join(tmpdir(), "c23-listener-")));
const children = new Set();
const completed = [];
let transcript = "";
let proxy;
let server;
let stalledPeer;
function check(name, actual) {
  console.log(`reached: ${name}`);
  assert.equal(process.env.C23_PLANT === name ? false : actual, true, name);
  completed.push(name);
}
function child(args, { input = "", imports = [], env = {}, entry = cli } = {}) {
  const processChild = spawn(
    process.execPath,
    [...imports.flatMap((path) => ["--import", path]), entry, ...args],
    { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] }
  );
  children.add(processChild);
  const result = {
    process: processChild,
    stdout: "",
    stderr: "",
    closed: false,
  };
  processChild.stdout.on("data", (chunk) => {
    result.stdout += chunk;
  });
  processChild.stderr.on("data", (chunk) => {
    result.stderr += chunk;
  });
  result.done = once(processChild, "close").then(([code, signal]) => {
    children.delete(processChild);
    result.closed = true;
    transcript += result.stdout + result.stderr;
    return { code, signal, stdout: result.stdout, stderr: result.stderr };
  });
  processChild.stdin.end(input);
  return result;
}
async function until(predicate, ms = 10_000) {
  const deadline = Date.now() + ms;
  do {
    if (await predicate()) return true;
    await delay(30);
  } while (Date.now() < deadline);
  return false;
}
async function stop(childProcess, signal) {
  childProcess.process.kill(signal);
  if (!(await until(() => childProcess.closed, 7_000)))
    childProcess.process.kill("SIGKILL");
  return childProcess.done;
}
async function run(args) {
  const processChild = child(args);
  if (!(await until(() => processChild.closed, 5_000)))
    await stop(processChild, "SIGTERM");
  return processChild.done;
}
async function port() {
  const socket = createTcpServer();
  socket.listen(0, "127.0.0.1");
  await once(socket, "listening");
  const selected = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return selected;
}
async function boot(file) {
  const processChild = child(["control-plane", "run", "--config", file]);
  const ready = await until(
    () =>
      processChild.closed ||
      processChild.stdout.includes('"event":"fleet-ready"')
  );
  return {
    processChild,
    ready:
      ready &&
      !processChild.closed &&
      processChild.stdout.includes('"event":"fleet-ready"'),
  };
}
function request(
  origin,
  path,
  { method = "GET", headers = {}, body, raw } = {}
) {
  return new Promise((resolve, reject) => {
    const encoded =
      raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const req = (origin.startsWith("https:") ? httpsRequest : httpRequest)(
      origin + path,
      {
        method,
        ca: readFileSync(join(root, "cert.pem")),
        servername: "localhost",
        headers: {
          ...(encoded === undefined
            ? {}
            : { "Content-Type": "application/json" }),
          ...headers,
        },
      },
      (response) => {
        let value = "";
        response.on("data", (chunk) => {
          value += chunk;
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: value,
          })
        );
      }
    );
    req.setTimeout(5_000, () => req.destroy(new Error("C23 request deadline")));
    req.on("error", reject);
    req.end(encoded);
  });
}
async function failsStartup(file, config, diagnostic) {
  writeFileSync(file, JSON.stringify(config));
  const outcome = await run(["control-plane", "run", "--config", file]);
  return (
    outcome.code !== 0 &&
    diagnostic.test(outcome.stderr) &&
    !outcome.stdout.includes("fleet-ready")
  );
}
const configPath = join(root, "fleet.yaml");
let origin;
let config;
let token;
let credential;
try {
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(root, "key.pem"),
      "-out",
      join(root, "cert.pem"),
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "-days",
      "1",
    ],
    { stdio: "ignore" }
  );
  const selectedPort = await port();
  origin = `https://127.0.0.1:${selectedPort}`;
  config = {
    publicOrigin: origin,
    dataDir: join(root, "fleet"),
    port: selectedPort,
    transport: { mode: "tls", certFile: "cert.pem", keyFile: "key.pem" },
  };
  const help = await run(["--help"]);
  const groupHelp = await run(["help", "control-plane"]);
  const version = await run(["control-plane", "--version"]);
  check(
    "shared CLI help",
    help.code === 0 &&
      help.stdout.includes("control-plane run") &&
      groupHelp.stdout.includes("fleet") &&
      version.code === 0 &&
      /\d+\.\d+\.\d+/.test(version.stdout)
  );
  writeFileSync(
    configPath,
    `publicOrigin: ${origin}
dataDir: ${JSON.stringify(config.dataDir)}
port: ${selectedPort}
transport:
  mode: tls
  certFile: cert.pem
  keyFile: key.pem
`
  );
  const started = await boot(configPath);
  server = started.processChild;
  const health = started.ready ? await request(origin, "/healthz") : undefined;
  check(
    "foreground readiness",
    started.ready &&
      health?.status === 200 &&
      health.body === '{"status":"ready"}'
  );
  const badPath = join(root, "invalid.yaml");
  check(
    "invalid configuration diagnostics",
    await failsStartup(
      badPath,
      { ...config, unexpected: true },
      /Unknown fleet config field/
    )
  );
  const unsafe = join(root, "unsafe");
  mkdirSync(unsafe, { mode: 0o755 });
  chmodSync(unsafe, 0o755);
  check(
    "unsafe storage diagnostics",
    await failsStartup(badPath, { ...config, dataDir: unsafe }, /private|0700/)
  );
  check(
    "TLS material diagnostics",
    await failsStartup(
      badPath,
      {
        ...config,
        transport: { ...config.transport, certFile: "missing.pem" },
      },
      /TLS.*ENOENT|TLS.*missing/
    )
  );
  const pages = await Promise.all(
    ["/environments", "/projects"].map((path) => request(origin, path))
  );
  check(
    "fleet pages",
    pages.every((page) => page.status === 200 && /<html/.test(page.body))
  );
  const assets = await Promise.all(
    [
      "/fleet-assets/imgSymbolLayers.svg",
      "/fleet-assets/environments/imgSymbolLayers.svg",
      "/fleet-assets/runs/imgSymbolLayers.svg",
      "/fleet-assets/runs.js",
    ].map((path) => request(origin, path))
  );
  check(
    "packaged local assets",
    assets.every((asset) => asset.status === 200 && asset.body.length > 40)
  );
  const browser = {
    cookie: pages[0].headers["set-cookie"][0].split(";")[0],
    Origin: origin,
    "X-CSRF-Token": /data-csrf="([^"]+)"/.exec(pages[0].body)[1],
  };
  const noCsrf = await request(origin, "/environments", {
    method: "POST",
    body: { name: "Forbidden" },
  });
  check(
    "missing CSRF rejected",
    noCsrf.status === 401 && !noCsrf.headers["access-control-allow-origin"]
  );
  const crossOrigin = await request(origin, "/environments", {
    method: "POST",
    headers: { ...browser, Origin: "https://other.invalid" },
    body: { name: "Forbidden" },
  });
  check(
    "cross origin rejected",
    crossOrigin.status === 401 &&
      !crossOrigin.headers["access-control-allow-origin"]
  );
  const wrongHost = await request(origin, "/healthz", {
    headers: { Host: "other.invalid" },
  });
  check("configured Host required", wrongHost.status === 401);
  const duplicate = await request(origin, "/environments", {
    method: "POST",
    headers: browser,
    raw: '{"name":"one","name":"two"}',
  });
  check("duplicate body rejected", duplicate.status === 400);
  const oversizedEnrollment = await request(origin, "/api/v1/agents/enroll", {
    method: "POST",
    raw: " ".repeat(16 * 1024) + "{}",
  });
  check(
    "enrollment body capped",
    oversizedEnrollment.status === 400 &&
      JSON.parse(oversizedEnrollment.body).error.message ===
        "Request body exceeds fleet byte limit"
  );
  const agentJson = await request(origin, "/api/v1/agents/sessions", {
    method: "POST",
    raw: " ".repeat(16 * 1024) + '{"protocolVersion":1,"protocolVersion":0}',
  });
  check(
    "agent protocol JSON semantics",
    JSON.parse(agentJson.body).error.code === "unsupported_protocol"
  );
  const browserAgent = await request(origin, "/api/v1/agents/sessions", {
    method: "POST",
    headers: browser,
    body: { actor: "local-owner" },
  });
  check("browser actor cannot authenticate agent", browserAgent.status === 401);
  const created = await request(origin, "/environments", {
    method: "POST",
    headers: browser,
    body: { name: "Production listener host" },
  });
  const connection = JSON.parse(created.body);
  token = /id="enrollment-token"[^>]*>([^<]+)</.exec(
    connection.connection
  )?.[1];
  check(
    "persisted browser environment",
    created.status === 201 &&
      typeof connection.environmentId === "string" &&
      token?.length === 43
  );
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { mode: 0o700 });
  const osHome = join(root, "os-home");
  mkdirSync(osHome, { mode: 0o700 });
  const agentConfig = join(agentDir, "config.json");
  writeFileSync(
    agentConfig,
    JSON.stringify({
      version: 1,
      dataDirectory: agentDir,
      projectConfigDir: join(root, "projects"),
      nodePath: realpathSync(process.execPath),
      cliPath: cli,
      caFile: join(root, "cert.pem"),
    }),
    { mode: 0o600 }
  );
  const setup = child(
    [
      "agent",
      "setup",
      "--server",
      origin,
      "--agent-config",
      agentConfig,
      "--token-stdin",
    ],
    { imports: [peer], env: { C23_OS_HOME: osHome }, input: token + "\n" }
  );
  const setupClosed = await until(() => setup.closed);
  if (!setupClosed) await stop(setup, "SIGTERM");
  const setupResult = await setup.done;
  check(
    "CLI setup against production listener",
    setupClosed &&
      setupResult.code === 0 &&
      setupResult.stdout.includes('"stage":"started"') &&
      existsSync(join(osHome, "started"))
  );
  const registry = JSON.parse(
    readFileSync(join(agentDir, "registry.json"), "utf8")
  );
  credential = registry.identity.credential;
  // Start the actual entry named by the native definition. Only OS supervision
  // is simulated; HTTPS, TLS trust, credential/session/observation are production.
  const agentArgs = [
    "--config",
    agentConfig,
    ...(platform() === "linux" ? ["--native-service=linux"] : []),
  ];
  let agent = child(agentArgs, { entry: join(dirname(cli), "agent-entry.js") });
  const firstSignal = await until(
    async () =>
      JSON.parse(
        (
          await request(
            origin,
            `/environments/${connection.environmentId}/connection`
          )
        ).body
      ).stage === "online"
  );
  const connected = await request(
    origin,
    `/environments/${connection.environmentId}/connection`
  );
  check(
    "CP21 zero project signal",
    firstSignal &&
      JSON.parse(connected.body).connection.includes("No projects yet")
  );
  const sessionId = () => {
    const db = new DatabaseSync(join(config.dataDir, "fleet.sqlite"), {
      readOnly: true,
    });
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      return db
        .prepare("SELECT session_id FROM agent_sessions WHERE environment_id=?")
        .get(connection.environmentId)?.session_id;
    } finally {
      db.close();
    }
  };
  const firstSession = sessionId();
  const conflict = await run(["control-plane", "run", "--config", configPath]);
  const stillOnline =
    JSON.parse(
      (
        await request(
          origin,
          `/environments/${connection.environmentId}/connection`
        )
      ).body
    ).stage === "online";
  check(
    "occupied port without fallback",
    conflict.code !== 0 &&
      /Fleet bind/.test(conflict.stderr) &&
      !conflict.stdout.includes("fleet-ready") &&
      stillOnline
  );
  const firstStop = await stop(server, "SIGINT");
  check(
    "SIGINT drains listener",
    firstStop.code === 0 &&
      firstStop.signal === null &&
      (await request(origin, "/healthz").then(
        () => false,
        () => true
      ))
  );
  await stop(agent, "SIGTERM");
  const restarted = await boot(configPath);
  server = restarted.processChild;
  const savedPage = restarted.ready
    ? await request(origin, "/environments")
    : undefined;
  check(
    "restart preserves environments",
    restarted.ready && savedPage.body.includes("Production listener host")
  );
  agent = child(agentArgs, { entry: join(dirname(cli), "agent-entry.js") });
  const reconnected = await until(
    async () =>
      JSON.parse(
        (
          await request(
            origin,
            `/environments/${connection.environmentId}/connection`
          )
        ).body
      ).stage === "online" && sessionId() !== firstSession
  );
  check("saved agent reconnects after restart", reconnected);
  await stop(agent, "SIGTERM");
  stalledPeer = connect(config.port, "127.0.0.1");
  await once(stalledPeer, "connect");
  await delay(20); // Accepted TCP peer deliberately sends no TLS handshake.
  const secondStop = await stop(server, "SIGTERM");
  stalledPeer.destroy();
  check(
    "SIGTERM closes storage",
    secondStop.code === 0 &&
      secondStop.signal === null &&
      readFileSync(join(config.dataDir, "fleet.sqlite")).length > 0
  );
  // A real TLS-terminating reverse proxy forwards to the production HTTP backend.
  const backendPort = await port();
  let publicPort = await port();
  while (publicPort === backendPort) publicPort = await port();
  const proxyOrigin = `https://127.0.0.1:${publicPort}`;
  const backendOrigin = `http://127.0.0.1:${backendPort}`;
  writeFileSync(
    configPath,
    JSON.stringify({
      ...config,
      publicOrigin: proxyOrigin,
      port: backendPort,
      transport: { mode: "trusted-proxy" },
    })
  );
  const proxied = await boot(configPath);
  server = proxied.processChild;
  if (proxied.ready) {
    proxy = createHttpsServer(
      {
        key: readFileSync(join(root, "key.pem")),
        cert: readFileSync(join(root, "cert.pem")),
      },
      (req, res) => {
        const upstream = httpRequest(
          backendOrigin + req.url,
          { method: req.method, headers: req.headers },
          (response) => {
            res.writeHead(response.statusCode, response.headers);
            response.pipe(res);
          }
        );
        upstream.on("error", () => {
          res.writeHead(502);
          res.end();
        });
        req.pipe(upstream);
      }
    );
    proxy.listen(publicPort, "127.0.0.1");
    await once(proxy, "listening");
  }
  const proxyHealth = proxied.ready
    ? await request(proxyOrigin, "/healthz")
    : undefined;
  const wrongBackendHost = proxied.ready
    ? await request(backendOrigin, "/healthz")
    : undefined;
  check(
    "trusted HTTPS proxy boundary",
    proxied.ready &&
      proxyHealth.status === 200 &&
      wrongBackendHost.status === 401
  );
  await stop(server, "SIGTERM");
  check(
    "diagnostics do not expose secrets",
    !transcript.includes(token) && !transcript.includes(credential)
  );
  console.log(
    JSON.stringify(
      {
        scenario: "C23 production fleet listener",
        platform: platform(),
        node: process.version,
        cliSha256: createHash("sha256").update(readFileSync(cli)).digest("hex"),
        nativeServices:
          "independent OS peer; actual CLI setup and agent entry; no native supervision/isolation acceptance",
        assertions: completed,
      },
      null,
      2
    )
  );
} finally {
  stalledPeer?.destroy();
  for (const processChild of children) processChild.kill("SIGKILL");
  await Promise.allSettled(
    [...children].map((processChild) => once(processChild, "close"))
  );
  if (proxy) {
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
  }
  rmSync(root, { recursive: true, force: true });
}
