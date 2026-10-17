// C05 black-box: bundled foreground child, actual C04/C05 HTTPS peer and local CLI daemon.
// Inventory IDs/projection are an independent C06 fixture; no command executor is supplied.
import assert from "node:assert/strict";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { once } from "node:events";
import { randomUUID, createHash } from "node:crypto";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, request as httpsRequest } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import {
  AgentRegistry,
  createAgentTransport,
  enrollAgent,
  runForegroundAgent,
} from "../packages/cli/dist/management-agent.js";
import {
  createLocalManagementAdapter,
  inspectLocalProject,
  resolveCanonicalRuntime,
} from "../packages/cli/dist/management-local.js";
import {
  openFleetStore,
  createEnrollmentService,
  createSessionService,
} from "../packages/fleet-control-plane/dist/index.js";
import {
  ERROR_HTTP_STATUS,
  pollRequestSchema,
  observationRequestSchema,
} from "../packages/management-protocol/dist/index.js";

const self = fileURLToPath(import.meta.url);
const cli = join(dirname(self), "../packages/cli/dist/index.js");
const probe = process.env.AGENT_TRANSPORT_PLANT_FORBIDDEN;
const role = process.argv[2];

async function serverRole(root, port) {
  const store = openFleetStore(join(root, "fleet"));
  store.database.exec(
    "CREATE TABLE IF NOT EXISTS fixture_projection (environment_id TEXT PRIMARY KEY, body TEXT NOT NULL, count INTEGER NOT NULL)"
  );
  let clock = Date.now(),
    sessions;
  const enrollment = createEnrollmentService(store, {
    now: () => new Date(clock),
    invalidateManagementAccess(database, environmentId) {
      sessions.invalidate(database, environmentId);
      return undefined;
    },
  });
  sessions = createSessionService(store, enrollment, {
    now: () => new Date(clock),
    receiveObservation(database, request) {
      database
        .prepare(
          "INSERT INTO fixture_projection VALUES (?, ?, 1) ON CONFLICT(environment_id) DO UPDATE SET body=excluded.body, count=count+1"
        )
        .run(request.environmentId, JSON.stringify(request));
      return undefined;
    },
  });
  sessions.recoverAfterRestart();
  const pending = new Set();
  const server = createServer(
    {
      key: readFileSync(join(root, "key")),
      cert: readFileSync(join(root, "cert")),
    },
    async (req, res) => {
      res.setHeader("content-type", "application/json");
      res.setHeader("cache-control", "no-store");
      const url = new URL(req.url, "https://localhost");
      let input,
        requestId = randomUUID();
      function failure(error) {
        if (res.destroyed || res.writableEnded) return;
        const code =
          error.code in ERROR_HTTP_STATUS ? error.code : "invalid_input";
        res.writeHead(ERROR_HTTP_STATUS[code]);
        res.end(
          JSON.stringify({
            error: { code, message: "Fixture request rejected", requestId },
          })
        );
      }
      try {
        let raw = "";
        for await (const chunk of req) {
          raw += String(chunk);
          if (Buffer.byteLength(raw) > 4 * 1024 * 1024)
            throw new Error("Body bound");
        }
        input = raw ? JSON.parse(raw) : Object.fromEntries(url.searchParams);
        if (!raw) input.protocolVersion = Number(input.protocolVersion);
        requestId = input.requestId ?? requestId;
        if (url.pathname === "/api/v1/agents/enroll") {
          res.end(JSON.stringify(await enrollment.enroll(input)));
          return;
        }
        const credential =
          req.headers.authorization?.replace(/^Bearer /, "") ?? "";
        const record = store.database
          .prepare(
            "SELECT agent_id FROM agent_credentials WHERE environment_id = ?"
          )
          .get(input.environmentId);
        const identity = {
          environmentId: input.environmentId,
          agentId: record?.agent_id ?? randomUUID(),
          credential,
        };
        if (url.pathname === "/api/v1/agents/sessions") {
          const request = input;
          if (
            probe === "exclusive" &&
            store.database
              .prepare(
                "SELECT session_id FROM agent_sessions WHERE environment_id = ?"
              )
              .get(input.environmentId)
          )
            store.database
              .prepare("DELETE FROM agent_sessions WHERE environment_id = ?")
              .run(input.environmentId);
          res.end(
            JSON.stringify(await sessions.openSession(identity, request))
          );
        } else if (url.pathname === "/api/v1/agents/observations") {
          observationRequestSchema.parse(input);
          res.end(JSON.stringify(await sessions.observe(identity, input)));
        } else if (url.pathname === "/api/v1/agents/poll") {
          const request = pollRequestSchema.parse(input);
          sessions.authenticateSession({
            ...identity,
            sessionId: request.sessionId,
          });
          const finish = () => {
            pending.delete(finish);
            clearTimeout(timer);
            if (res.destroyed) return;
            try {
              sessions.authenticateSession({
                ...identity,
                sessionId: request.sessionId,
              });
              res.end(JSON.stringify({ ...request, commands: [], reads: [] }));
            } catch (error) {
              failure(error);
            }
          };
          const timer = setTimeout(finish, 25_000);
          pending.add(finish);
          res.once("close", () => {
            pending.delete(finish);
            clearTimeout(timer);
          });
        } else {
          res.writeHead(404);
          res.end("{}");
        }
      } catch (error) {
        failure(error);
      }
    }
  );
  server.listen(Number(port), "127.0.0.1");
  await once(server, "listening");
  process.send({
    ready: true,
    origin: `https://localhost:${server.address().port}`,
  });
  process.on("message", async ({ id, operation, environmentId }) => {
    try {
      let result;
      if (operation === "create")
        result = await enrollment.createEnvironment({
          name: "C05 fixture host",
        });
      if (operation === "state") {
        const environments = await enrollment.listEnvironments();
        const projection = store.database
          .prepare(
            "SELECT body, count FROM fixture_projection WHERE environment_id = ?"
          )
          .get(environmentId);
        const session = store.database
          .prepare(
            "SELECT session_id, sequence FROM agent_sessions WHERE environment_id = ?"
          )
          .get(environmentId);
        result = {
          environment: environments.find(
            (e) => e.environmentId === environmentId
          ),
          projection: projection
            ? { count: projection.count, body: JSON.parse(projection.body) }
            : null,
          session,
        };
      }
      if (operation === "expire") {
        clock += 31_000;
        sessions.expire();
        result = true;
      }
      if (operation === "revoke") {
        await enrollment.revoke(environmentId);
        for (const finish of [...pending]) finish();
        result = true;
      }
      if (operation === "plant-online") {
        store.database
          .prepare("UPDATE environments SET connection='online' WHERE id=?")
          .run(environmentId);
        result = true;
      }
      if (operation === "plant-sequence") {
        store.database
          .prepare(
            "UPDATE fixture_projection SET count=count+1 WHERE environment_id=?"
          )
          .run(environmentId);
        result = true;
      }
      process.send({ id, result });
    } catch (error) {
      process.send({ id, error: error.code ?? "fixture_failure" });
    }
  });
  process.once("SIGTERM", () => {
    server.closeAllConnections();
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}

async function agentRole(root, directory) {
  const controller = new AbortController();
  process.once("SIGTERM", () => controller.abort());
  process.once("SIGINT", () => controller.abort());
  let pendingProject,
    generation = 0,
    projectId;
  process.on("message", (message) => {
    if (message.project) {
      pendingProject = message.project;
      projectId = message.projectId;
    }
    if (message.generation) generation = message.generation;
  });
  let local;
  try {
    await runForegroundAgent({
      directory,
      agentVersion: "C05-blackbox",
      signal: controller.signal,
      client: (identity, signal) =>
        createAgentTransport({
          serverOrigin: identity.serverOrigin,
          identity: () => identity,
          signal,
          ca: readFileSync(join(root, "cert")),
          timeoutMs: 30_000,
        }),
      snapshot: async (registry) => {
        local ??= createLocalManagementAdapter(registry, {
          configDir: join(root, "cli"),
          executable: process.execPath,
          argumentPrefix: [cli],
          launchContext: { kind: "foreground" },
        });
        if (pendingProject) {
          await registry.add(pendingProject);
          pendingProject = undefined;
        }
        const inventory = await registry.inventory(
          local.reader,
          "C05-blackbox"
        );
        return inventory.map((p) => ({
          ...p,
          projectId,
          snapshot: {
            ...(typeof p.snapshot === "object" ? p.snapshot : {}),
            fixtureGeneration: generation,
          },
        }));
      },
      onConnection: (state, code) =>
        console.log(JSON.stringify({ state, code })),
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    process.disconnect();
  }
}

async function main() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "c05-blackbox-")));
  let server,
    agent,
    origin,
    registry,
    identity,
    managedPid,
    managedLocalId,
    managedFingerprint;
  let output = "",
    errors = "",
    assertions = 0;
  const folder = join(root, "prepared"),
    configDir = join(root, "cli");
  const environment = {
    ...process.env,
    GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH: join(root, "issues.json"),
  };
  const check = (condition, label) => {
    assertions++;
    console.log(`reached: ${label}`);
    assert.ok(condition, label);
  };
  const run = (args) =>
    spawnSync(
      process.execPath,
      [cli, "--config", configDir, "--json", "project", ...args],
      { cwd: folder, env: environment, encoding: "utf8", timeout: 15_000 }
    );
  async function stop(child) {
    if (!child || child.exitCode !== null) return;
    const ended = once(child, "exit");
    child.kill("SIGTERM");
    await Promise.race([
      ended,
      delay(5_000).then(() => {
        throw new Error("Child shutdown timeout");
      }),
    ]);
  }
  async function startServer(port = 0) {
    server = spawn(process.execPath, [self, "--server", root, String(port)], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    server.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    origin = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Peer startup timeout")),
        10_000
      );
      server.once("error", reject);
      server.once("exit", () => reject(new Error("Peer startup exited")));
      server.on("message", (message) => {
        if (message.ready) {
          clearTimeout(timeout);
          resolve(message.origin);
        }
      });
    });
  }
  function rpc(operation, environmentId = identity?.environmentId) {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timeout = setTimeout(() => {
        server.off("message", listener);
        reject(new Error("Peer RPC timeout"));
      }, 5_000);
      function listener(message) {
        if (message.id !== id) return;
        clearTimeout(timeout);
        server.off("message", listener);
        if (message.error) reject(new Error(message.error));
        else resolve(message.result);
      }
      server.on("message", listener);
      server.send({ id, operation, environmentId });
    });
  }
  async function until(predicate, label, timeout = 15_000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (await predicate()) return;
      await delay(50);
    }
    throw new Error(`Timed out: ${label}; child exit=${agent?.exitCode}`);
  }
  function transport(saved = identity) {
    return createAgentTransport({
      serverOrigin: origin,
      identity: () => saved,
      ca: readFileSync(join(root, "cert")),
    });
  }
  function launchAgent(directory) {
    output = "";
    agent = spawn(process.execPath, [self, "--agent", root, directory], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: environment,
    });
    agent.stdout.on("data", (chunk) => {
      output += chunk;
    });
    agent.stderr.on("data", (chunk) => {
      errors += chunk;
    });
  }
  async function daemonAlive(label) {
    if (probe === "continuity" && label.includes("disconnect"))
      run(["stop", "--project-dir", folder]);
    const observed = await inspectLocalProject(
      configDir,
      {
        localProjectId: managedLocalId,
        canonicalPath: folder,
        registeredPath: folder,
      },
      environment
    );
    check(
      observed.process.state === "running" &&
        observed.process.pid === managedPid &&
        createHash("sha256").update(observed.process.identity).digest("hex") ===
          managedFingerprint,
      label
    );
  }
  try {
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--json", "--pack-destination", root], {
        cwd: join(dirname(cli), ".."),
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
    )[0];
    const packedFiles = new Set(packed.files.map((file) => file.path));
    if (probe === "package") packedFiles.delete("dist/management-agent.d.ts");
    check(
      packedFiles.has("dist/management-agent.js") &&
        packedFiles.has("dist/management-agent.d.ts"),
      "pack includes typed foreground entry"
    );
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(root, "key"),
        "-out",
        join(root, "cert"),
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
      ],
      { stdio: "ignore" }
    );
    await startServer();
    const token = await rpc("create");
    registry = await AgentRegistry.open(join(root, "agent"));
    identity = await enrollAgent(
      registry,
      transport(null),
      origin,
      token.token
    );
    if (probe === "premature") await rpc("plant-online");
    check(
      (await rpc("state")).environment.connection === "awaiting-signal",
      "CP-21 exchange alone awaits first signal"
    );
    check(
      statSync(join(root, "agent", "registry.json")).mode % 512 === 0o600,
      "private saved credential mode"
    );
    await registry.close();
    registry = await AgentRegistry.open(join(root, "agent"));
    const resumed = await enrollAgent(registry, transport(), origin, "");
    check(
      resumed.agentId === identity.agentId,
      "saved enrollment resumes without token"
    );
    await assert.rejects(
      transport().enroll({
        protocolVersion: 1,
        requestId: randomUUID(),
        token: token.token,
      })
    );
    check(true, "CP-11 enrollment token reuse rejected");
    const sessionInput = {
      protocolVersion: 1,
      requestId: randomUUID(),
      environmentId: identity.environmentId,
      agentId: identity.agentId,
      agentVersion: "C05-peer",
      host: { hostname: "fixture", os: process.platform },
    };
    const first = await transport().openSession(sessionInput);
    let rejected = false;
    try {
      await transport().openSession({
        ...sessionInput,
        requestId: randomUUID(),
      });
    } catch (error) {
      rejected = error.code === "session_conflict";
    }
    check(rejected, "CP-10 live second session rejected");
    const observation = (sequence) => ({
      protocolVersion: 1,
      requestId: randomUUID(),
      environmentId: identity.environmentId,
      sessionId: first.sessionId,
      sequence,
      observedAt: "2099-01-01T00:00:00Z",
      inventory: {
        revisionId: randomUUID(),
        pageIndex: 0,
        pageCount: 1,
        projects: [],
      },
    });
    await transport().observe(observation(2));
    const received = await rpc("state");
    check(
      received.environment.connection === "online" &&
        !received.environment.lastContactAt.startsWith("2099"),
      "CP-10 receipt time ignores agent clock skew"
    );
    await transport().observe(observation(1));
    if (probe === "sequence") await rpc("plant-sequence");
    check(
      (await rpc("state")).projection.count === 1,
      "CP-10 older observation cannot replace projection"
    );
    await assert.rejects(
      transport({
        ...identity,
        credential: "wrong-fixture-credential",
      }).observe(observation(3))
    );
    check(true, "CP-11 wrong credential rejected before projection");
    // Independent raw peer bypasses the client's local v1 validation to exercise server negotiation.
    const invalid = await new Promise((resolve, reject) => {
      const req = httpsRequest(
        new URL("/api/v1/agents/sessions", origin),
        {
          method: "POST",
          ca: readFileSync(join(root, "cert")),
          headers: {
            authorization: `Bearer ${identity.credential}`,
            "content-type": "application/json",
          },
        },
        (res) => {
          let body = "";
          res.on("data", (b) => {
            body += b;
          });
          res.on("end", () => resolve(JSON.parse(body)));
        }
      );
      req.on("error", reject);
      req.end(JSON.stringify({ ...sessionInput, protocolVersion: 2 }));
    });
    check(
      invalid.error.code === "unsupported_protocol",
      "CP-17 incompatible protocol rejected"
    );
    await rpc("expire");
    await assert.rejects(transport().observe(observation(3)));
    check(
      (await rpc("state")).environment.connection === "offline",
      "expired session becomes offline and rejects old messages"
    );
    await registry.close();
    registry = undefined;

    mkdirSync(folder);
    mkdirSync(configDir);
    writeFileSync(join(root, "issues.json"), "[]");
    writeFileSync(
      join(folder, "WORKFLOW.md"),
      `---
tracker:
  kind: file
  provider:
    path: $GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH
    project_id: c05-blackbox
  active_states: [Ready]
polling:
  interval_ms: 1000
codex:
  command: codex
repository:
  slug: fixture/project
---
Fixture prompt
`
    );
    const started = run(["start", "--project-dir", folder, "--daemon"]);
    assert.equal(started.status, 0, started.stdout + started.stderr);
    const runtime = await resolveCanonicalRuntime(configDir, folder);
    managedPid = JSON.parse(
      readFileSync(
        join(
          runtime.configDir,
          "projects",
          runtime.runtimeProjectId,
          "daemon.pid"
        ),
        "utf8"
      )
    ).pid;
    launchAgent(join(root, "agent"));
    await until(
      async () => (await rpc("state")).environment.connection === "online",
      "foreground first signal"
    );
    check(
      (await rpc("state")).projection.body.inventory.projects.length === 0,
      "CP-21 foreground zero-project connection succeeds"
    );
    const globalId = randomUUID(); // Independently assigned by C06 fixture, never fabricated in production.
    agent.send({ project: folder, projectId: globalId, generation: 1 });
    await until(
      async () =>
        (await rpc("state")).projection?.body.inventory.projects[0]?.snapshot
          ?.fixtureGeneration === 1,
      "prepared project observation"
    );
    const projected = (await rpc("state")).projection.body.inventory
      .projects[0];
    managedLocalId = projected.localProjectId;
    managedFingerprint = projected.process.identity;
    check(
      projected.process.state === "running" &&
        projected.process.pid === managedPid,
      "typed C03 inventory reports actual orchestrator"
    );

    const previousSession = (await rpc("state")).session.session_id;
    const port = Number(new URL(origin).port);
    await stop(server);
    agent.send({ generation: 2 });
    await until(() => output.includes("retrying"), "outbound disconnect retry");
    await daemonAlive("CP-05 disconnect preserves orchestrator");
    await assert.rejects(AgentRegistry.open(join(root, "agent")));
    check(true, "foreground retains local exclusive lock through outage");
    await startServer(port);
    check(
      (await rpc("state")).environment.connection === "offline",
      "peer restart retains explicitly stale observation"
    );
    await until(
      async () => {
        const state = await rpc("state");
        return (
          state.environment.connection === "online" &&
          state.projection?.body.inventory.projects[0]?.snapshot
            ?.fixtureGeneration === 2
        );
      },
      "HTTPS/SQLite peer restart recovery",
      20_000
    );
    const recovered = await rpc("state");
    check(
      recovered.projection.body.sessionId !== previousSession,
      "restart fences old session and reconnects saved identity"
    );
    check(
      recovered.projection.body.inventory.projects[0].snapshot
        .fixtureGeneration === 2,
      "CP-05 reconnect sends current snapshot"
    );
    await daemonAlive("CP-05 peer restart preserves orchestrator");
    await rpc("revoke");
    await until(() => agent.exitCode !== null, "revoked foreground exit");
    check(
      agent.exitCode === 1 && errors.includes("unauthenticated"),
      "CP-11 revoked credential stops outbound agent"
    );
    await daemonAlive("CP-11 revocation preserves orchestrator");
    registry = await AgentRegistry.open(join(root, "agent"));
    check(
      registry.identity.agentId === identity.agentId,
      "revocation releases lock and preserves saved identity"
    );
    await registry.close();
    registry = undefined;
    if (probe === "credential") output += identity.credential;
    check(
      !output.includes(identity.credential) &&
        !errors.includes(identity.credential) &&
        !output.includes(token.token) &&
        !errors.includes(token.token),
      "credential absent from child diagnostics"
    );

    const nextToken = await rpc("create");
    const nextRegistry = await AgentRegistry.open(join(root, "second-agent"));
    await enrollAgent(nextRegistry, transport(null), origin, nextToken.token);
    await nextRegistry.close();
    launchAgent(join(root, "second-agent"));
    await until(() => output.includes("online"), "second foreground online");
    await stop(agent);
    check(agent.exitCode === 0, "foreground SIGTERM exits cleanly");
    await daemonAlive("foreground SIGTERM preserves orchestrator");
    console.log(
      JSON.stringify({
        result: "pass",
        os: process.platform,
        assertions,
        scope:
          "actual HTTPS/SQLite/processes; no native service installation or OS service isolation claim",
      })
    );
  } finally {
    await registry?.close();
    await stop(agent).catch(() => agent?.kill("SIGKILL"));
    await stop(server);
    if (managedPid) run(["stop", "--project-dir", folder]);
    rmSync(root, { recursive: true, force: true });
  }
}

if (role === "--server") await serverRole(process.argv[3], process.argv[4]);
else if (role === "--agent") await agentRole(process.argv[3], process.argv[4]);
else await main();
