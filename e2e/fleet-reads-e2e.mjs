// C10 operator HTTPS → actual C04/C05 services → C09 filesystem adapter.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  renameSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request as httpsRequest } from "node:https";
import {
  createEnrollmentService,
  createSessionService,
  createBrowserSecurity,
  createReadService,
  createReadRoutes,
  createCommandService,
  openFleetStore,
} from "../packages/fleet-control-plane/dist/index.js";
import {
  AgentRegistry,
  LocalReadAdapter,
} from "../packages/management-agent/dist/index.js";
import { readResultSchema } from "../packages/management-protocol/dist/index.js";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "c10-blackbox-")));
let store,
  registry,
  server,
  count = 0;
function check(value, label) {
  console.log(`reached: ${label}`);
  count++;
  assert.ok(value, label);
}
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
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" }
  );
  const ca = readFileSync(join(dir, "cert.pem"));
  let clock = Date.now();
  const now = () => new Date(clock);
  store = openFleetStore(join(dir, "fleet"));
  const db = store.database;
  db.exec(
    "CREATE TABLE fixture_projects(id TEXT PRIMARY KEY,local_id TEXT,online INTEGER); CREATE TABLE fixture_history(project_id TEXT PRIMARY KEY,runs TEXT,received_at TEXT)"
  );
  let sessions;
  const enrollment = createEnrollmentService(store, {
    now,
    invalidateManagementAccess(database, environmentId) {
      sessions.invalidate(database, environmentId);
      return undefined;
    },
  });
  sessions = createSessionService(store, enrollment, {
    now,
    receiveObservation: () => undefined,
  });
  const token = await enrollment.createEnvironment({ name: "C10 host" });
  const credential = await enrollment.enroll({
    protocolVersion: 1,
    requestId: randomUUID(),
    token: token.token,
  });
  const session = await sessions.openSession(credential, {
    protocolVersion: 1,
    requestId: randomUUID(),
    environmentId: credential.environmentId,
    agentId: credential.agentId,
    agentVersion: "1.0.0",
    host: {
      hostname: "fixture",
      os: process.platform === "darwin" ? "darwin" : "linux",
    },
  });
  const identity = { ...credential, sessionId: session.sessionId };
  await sessions.observe(credential, {
    protocolVersion: 1,
    requestId: randomUUID(),
    environmentId: identity.environmentId,
    sessionId: identity.sessionId,
    sequence: 0,
    observedAt: now().toISOString(),
    inventory: {
      revisionId: randomUUID(),
      pageIndex: 0,
      pageCount: 1,
      projects: [],
    },
  });
  mkdirSync(join(dir, "project"));
  registry = await AgentRegistry.open(join(dir, "agent"));
  const local = await registry.add(join(dir, "project"));
  const runtime = join(dir, "runtime");
  mkdirSync(join(runtime, "runs", "run-1"), { recursive: true });
  writeFileSync(
    join(runtime, "runs", "run-1", "run.json"),
    JSON.stringify({
      projectId: "runtime-project",
      runId: "run-1",
      status: "succeeded",
      createdAt: now().toISOString(),
      updatedAt: now().toISOString(),
      prompt: "must-not-leak",
    })
  );
  const log = join(runtime, "runs", "run-1", "worker.log");
  writeFileSync(log, "abcd");
  const project = randomUUID();
  db.prepare("INSERT INTO fixture_projects VALUES (?,?,1)").run(
    project,
    local.localProjectId
  );
  const peers = {
    resolveTarget(database, projectId) {
      const row = database
        .prepare("SELECT * FROM fixture_projects WHERE id=?")
        .get(projectId);
      if (!row) return undefined;
      return {
        projectId,
        environmentId: identity.environmentId,
        localProjectId: row.local_id,
        agentId: identity.agentId,
        sessionId: identity.sessionId,
        managed: true,
        valid: true,
        supported: true,
        online: row.online === 1,
      };
    },
    verifyAgent(_database, candidate) {
      sessions.authenticateSession(candidate);
      return true;
    },
  };
  const options = {
    peers,
    now,
    receiveRunSummaries(database, projectId, runs, receivedAt) {
      database
        .prepare("INSERT OR REPLACE INTO fixture_history VALUES (?,?,?)")
        .run(projectId, JSON.stringify(runs), receivedAt);
      return undefined;
    },
  };
  let reads = createReadService(store, options);
  const browser = createBrowserSecurity({ publicOrigin: "https://localhost" });
  const browserSession = browser.issueSession();
  let routes = createReadRoutes(reads, browser);
  server = createServer(
    { cert: ca, key: readFileSync(join(dir, "key.pem")) },
    async (req, res) => {
      try {
        const chunks = [];
        let bytes = 0;
        for await (const chunk of req) {
          bytes += chunk.length;
          if (bytes > 4 * 1024 * 1024) throw new Error("body limit");
          chunks.push(chunk);
        }
        const text = Buffer.concat(chunks).toString();
        const response = await routes({
          method: req.method,
          pathname: new URL(req.url, "https://localhost").pathname,
          origin: req.headers.origin,
          cookie: req.headers.cookie,
          csrfToken: req.headers["x-csrf-token"],
          body: text ? JSON.parse(text) : undefined,
        });
        res.writeHead(response?.status ?? 404, {
          "Content-Type": "application/json",
          ...response?.headers,
        });
        res.end(JSON.stringify(response?.body ?? {}));
      } catch {
        res.writeHead(500);
        res.end("{}");
      }
    }
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  async function http(method, path, body, csrf = browserSession.csrfToken) {
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method,
          ca,
          headers: {
            Origin: "https://localhost",
            Cookie: browserSession.setCookie.split(";")[0],
            "X-CSRF-Token": csrf,
            "Content-Type": "application/json",
          },
          timeout: 5000,
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: JSON.parse(Buffer.concat(chunks).toString()),
            })
          );
        }
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error("HTTPS timeout")));
      req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  const adapter = new LocalReadAdapter(registry, async () => ({
    projectDirectory: runtime,
    runtimeProjectId: "runtime-project",
  }));
  const envelope = () => ({
    protocolVersion: 1,
    environmentId: identity.environmentId,
    sessionId: identity.sessionId,
    requestId: randomUUID(),
  });
  async function fetchRead(selection) {
    const accepted = await http(
      "POST",
      `/api/v1/projects/${project}/reads`,
      selection
    );
    assert.equal(accepted.status, 202);
    const request = reads
      .poll(identity)
      .find((item) => item.readId === accepted.body.readId);
    assert.ok(request);
    const result = await adapter.read(request);
    await reads.publishResult(identity, {
      ...envelope(),
      result: { kind: "read", result },
    });
    const response = await http("GET", `/api/v1/reads/${accepted.body.readId}`);
    readResultSchema.parse(response.body);
    return response;
  }
  check(
    (
      await http(
        "POST",
        `/api/v1/projects/${project}/reads`,
        { kind: "runs", limit: 1 },
        "wrong"
      )
    ).status === 401,
    "CSRF rejects read admission"
  );
  check(
    (
      await http("POST", `/api/v1/projects/${project}/reads`, {
        kind: "log-chunk",
        runId: "run-1",
        stream: "../../secret",
        maxBytes: 4,
      })
    ).status === 400,
    "arbitrary stream rejected"
  );
  await createCommandService(store, { peers, now }).submitCommand(
    project,
    "start",
    { operation: "start" }
  );
  const history = await fetchRead({ kind: "runs", limit: 100 });
  check(
    history.body.state === "completed" &&
      history.body.payload.runs.length === 1 &&
      !JSON.stringify(history.body).includes("must-not-leak"),
    "bounded safe run summaries bypass lifecycle slot"
  );
  check(
    JSON.parse(
      db
        .prepare("SELECT runs FROM fixture_history WHERE project_id=?")
        .get(project)?.runs ?? "[]"
    ).length === 1,
    "projection receives cached summaries"
  );
  const detail = await fetchRead({ kind: "run-detail", runId: "run-1" });
  check(
    detail.body.state === "completed" && detail.body.payload.runId === "run-1",
    "known run detail"
  );
  const chunk = {
    kind: "log-chunk",
    runId: "run-1",
    stream: "worker",
    maxBytes: 4,
  };
  const first = await fetchRead(chunk);
  check(
    first.body.state === "completed" && first.body.payload.text === "abcd",
    "bounded log chunk"
  );
  appendFileSync(log, "efgh");
  const next = await fetchRead({ ...chunk, cursor: first.body.payload.cursor });
  check(
    next.body.payload.text === "efgh" && !next.body.payload.reset,
    "append follows byte cursor"
  );
  renameSync(log, `${log}.old`);
  writeFileSync(log, "new");
  const rotated = await fetchRead({
    ...chunk,
    cursor: next.body.payload.cursor,
  });
  check(
    rotated.body.payload.reset === true && rotated.body.payload.text === "new",
    "rotation reset preserved"
  );
  writeFileSync(log, "x");
  const truncated = await fetchRead({
    ...chunk,
    cursor: rotated.body.payload.cursor,
  });
  check(truncated.body.payload.reset === true, "truncation reset preserved");
  check(
    (await fetchRead({ ...chunk, stream: "events" })).body.state ===
      "unavailable",
    "missing log is unavailable"
  );
  check(
    (await fetchRead({ kind: "run-detail", runId: "../secret" })).body.state ===
      "unavailable",
    "traversal is unavailable"
  );
  const pending = await http("POST", `/api/v1/projects/${project}/reads`, {
    kind: "runs",
    limit: 1,
  });
  check(
    (
      await http("POST", `/api/v1/projects/${project}/reads`, {
        kind: "runs",
        limit: 1,
      })
    ).body.error?.code === "read_busy",
    "one pending read per project"
  );
  db.prepare("UPDATE fixture_projects SET online=0").run();
  check(
    (await http("GET", `/api/v1/reads/${pending.body.readId}`)).body.state ===
      "unavailable",
    "offline pending detail is unavailable"
  );
  const cached = await http("GET", `/api/v1/reads/${first.body.readId}`);
  check(
    cached.headers["x-symphony-historical"] === "true" &&
      cached.body.payload.text === "abcd",
    "offline completed content is historical"
  );
  check(
    (
      await http("POST", `/api/v1/projects/${project}/reads`, {
        kind: "runs",
        limit: 1,
      })
    ).body.error?.code === "agent_offline",
    "offline admission rejected"
  );
  db.prepare("UPDATE fixture_projects SET online=1").run();
  const expires = await http("POST", `/api/v1/projects/${project}/reads`, {
    kind: "runs",
    limit: 1,
  });
  clock += 30_000;
  check(
    (await http("GET", `/api/v1/reads/${expires.body.readId}`)).body.state ===
      "expired",
    "exact deadline expiry"
  );
  clock += 30_000;
  check(
    (await http("GET", `/api/v1/reads/${first.body.readId}`)).body.state ===
      "unavailable",
    "completed result retention ends"
  );
  reads = createReadService(store, options);
  routes = createReadRoutes(reads, browser);
  check(
    (await http("GET", `/api/v1/reads/${expires.body.readId}`)).body.state ===
      "unavailable",
    "restart makes unknown reads unavailable"
  );
  check(
    db.prepare("SELECT count(*) AS n FROM fixture_history").get().n === 1 &&
      !db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table'")
        .all()
        .some((row) => /raw_logs|read_results/.test(row.sql)),
    "restart preserves summaries without durable raw logs"
  );
  console.log(
    `PASS C10 ${count} reached assertions on ${process.platform}; HTTPS/library/filesystem integration, no native service isolation claim`
  );
} finally {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (registry) await registry.close();
  store?.close();
  rmSync(dir, { recursive: true, force: true });
}
