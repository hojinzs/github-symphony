// C18 test listener: real C04/C05/C06/C10 + C09 files; no lifecycle effects.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, request } from "node:https";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  appendFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openFleetStore,
  createEnrollmentService,
  createSessionService,
  createObservationService,
  createBrowserSecurity,
  createReadService,
  createReadRoutes,
  createRunRoutes,
  createProjectRoutes,
} from "../packages/fleet-control-plane/dist/index.js";
import {
  AgentRegistry,
  LocalReadAdapter,
} from "../packages/management-agent/dist/index.js";

export async function createRunFixture({ runCount = 26 } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "c18-blackbox-")));
  let store, registry, server, heartbeat;
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
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" }
    );
    const ca = readFileSync(join(root, "cert.pem"));
    let offset = 0;
    const now = () => new Date(Date.now() + offset);
    store = openFleetStore(join(root, "fleet"));
    const observations = createObservationService(store, {
      now,
      invalidateProject: () => undefined,
    });
    let sessions;
    const enrollment = createEnrollmentService(store, {
      now,
      invalidateManagementAccess: (db, id) => sessions.invalidate(db, id),
    });
    sessions = createSessionService(store, enrollment, {
      now,
      receiveObservation: observations.receiveObservation,
    });
    const pending = await enrollment.createEnvironment({ name: "lab-linux" });
    const credential = await enrollment.enroll({
      protocolVersion: 1,
      requestId: randomUUID(),
      token: pending.token,
    });
    const session = await sessions.openSession(credential, {
      protocolVersion: 1,
      requestId: randomUUID(),
      environmentId: credential.environmentId,
      agentId: credential.agentId,
      agentVersion: "fixture",
      host: {
        hostname: "fixture",
        os: process.platform === "darwin" ? "darwin" : "linux",
      },
    });
    const identity = { ...credential, sessionId: session.sessionId };
    registry = await AgentRegistry.open(join(root, "agent"));
    mkdirSync(join(root, "prepared"));
    const local = await registry.add(join(root, "prepared"));
    const projectId = observations.identifyProjects(identity.environmentId, [
      local.localProjectId,
    ])[0];
    const runtime = join(root, "runtime");
    const runs = Array.from({ length: runCount }, (_, i) => {
      const runId = "run-" + String(i + 1).padStart(3, "0");
      const directory = join(runtime, "runs", runId);
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "run.json"),
        JSON.stringify({
          projectId: "runtime-project",
          runId,
          status: "succeeded",
          createdAt: now().toISOString(),
          updatedAt: now().toISOString(),
        })
      );
      return {
        runId,
        status: "succeeded",
        startedAt: now().toISOString(),
        updatedAt: now().toISOString(),
      };
    });
    mkdirSync(join(runtime, "runs"), { recursive: true });
    const log = join(runtime, "runs/run-001/worker.log");
    if (runCount > 0) {
      writeFileSync(
        log,
        "12:37:06  session started\n12:39:20  tests completed\n<script>globalThis.logExecuted=true</script>\n"
      );
      writeFileSync(join(runtime, "orchestrator.log"), "orchestrator stream\n");
      writeFileSync(
        join(runtime, "runs/run-001/events.ndjson"),
        '{"event":"fixture"}\n'
      );
    }
    // run-002 deliberately has no worker.log: real missing-file outcome.
    let sequence = 0;
    let online = true;
    let hold = false;
    let seen = [];
    async function observe() {
      if (!online) return;
      await sessions.observe(credential, {
        protocolVersion: 1,
        requestId: randomUUID(),
        environmentId: identity.environmentId,
        sessionId: identity.sessionId,
        sequence: sequence++,
        observedAt: now().toISOString(),
        inventory: {
          revisionId: randomUUID(),
          pageIndex: 0,
          pageCount: 1,
          projects: [
            {
              projectId,
              localProjectId: local.localProjectId,
              displayName: "api-platform",
              canonicalPath: join(root, "prepared"),
              cliVersion: "fixture",
              validation: { state: "valid" },
              process: { state: "stopped", observedAt: now().toISOString() },
              observedAt: now().toISOString(),
              runs,
            },
          ],
        },
      });
    }
    await observe();
    const reads = createReadService(store, {
      peers: {
        resolveTarget(db, id) {
          return db.isTransaction
            ? observations.resolveTarget(db, id)
            : store.transaction(() => observations.resolveTarget(db, id));
        },
        verifyAgent(_db, candidate) {
          sessions.authenticateSession(candidate);
          return true;
        },
      },
      now,
    });
    const adapter = new LocalReadAdapter(registry, async () => ({
      projectDirectory: runtime,
      runtimeProjectId: "runtime-project",
    }));
    async function pump() {
      if (hold || !online) return;
      for (const read of reads.poll(identity)) {
        seen.push(read.selection);
        const result = await adapter.read(read);
        await reads.publishResult(identity, {
          protocolVersion: 1,
          requestId: randomUUID(),
          environmentId: identity.environmentId,
          sessionId: identity.sessionId,
          result: { kind: "read", result },
        });
      }
    }
    let runRoutes, readRoutes, projectRoutes;
    server = createServer(
      { cert: ca, key: readFileSync(join(root, "key.pem")) },
      async (req, res) => {
        try {
          const chunks = [];
          let length = 0;
          for await (const chunk of req) {
            length += chunk.length;
            if (length > 16 * 1024)
              throw new Error("Fixture request body too large");
            chunks.push(chunk);
          }
          const raw = Buffer.concat(chunks).toString();
          const input = {
            method: req.method,
            pathname: req.url,
            origin: req.headers.origin,
            cookie: req.headers.cookie,
            csrfToken: req.headers["x-csrf-token"],
            body: raw ? JSON.parse(raw) : undefined,
          };
          const api = await readRoutes(input);
          if (api) {
            // Real adapter resolves accepted work; hold exercises pending expiry.
            if (api.status === 202) await pump();
            res.writeHead(api.status, {
              "Content-Type": "application/json",
              ...api.headers,
            });
            res.end(JSON.stringify(api.body));
            return;
          }
          const page = (await runRoutes(input)) ?? (await projectRoutes(input));
          res.writeHead(page?.status ?? 404, page?.headers);
          res.end(page?.body ?? "");
        } catch (error) {
          res.writeHead(500);
          res.end(String(error));
        }
      }
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const origin = "https://127.0.0.1:" + server.address().port;
    const browser = createBrowserSecurity({ publicOrigin: origin });
    runRoutes = createRunRoutes(observations, browser, {
      environments: enrollment.listEnvironments,
      now,
    });
    readRoutes = createReadRoutes(reads, browser);
    projectRoutes = createProjectRoutes(observations, {
      environments: enrollment.listEnvironments,
      now,
    });
    heartbeat = setInterval(() => {
      void observe();
    }, 5000);
    const http = (method, path, { body, cookie, csrf } = {}) =>
      new Promise((resolve, reject) => {
        const req = request(
          origin + path,
          {
            method,
            ca,
            headers: {
              Origin: origin,
              ...(cookie ? { Cookie: cookie } : {}),
              ...(csrf ? { "X-CSRF-Token": csrf } : {}),
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
                text: Buffer.concat(chunks).toString(),
              })
            );
          }
        );
        req.on("error", reject);
        req.on("timeout", () =>
          req.destroy(new Error("Fixture HTTPS timeout"))
        );
        req.end(body ? JSON.stringify(body) : undefined);
      });
    return {
      origin,
      projectId,
      environmentId: identity.environmentId,
      path: "/projects/" + projectId + "/runs",
      http,
      log,
      get selections() {
        return [...seen];
      },
      async observeNow() {
        await observe();
        return (await observations.getProject(projectId)).observation
          .observedAt;
      },
      async hold(value) {
        hold = value;
        if (!hold) await pump();
      },
      async offline(value) {
        online = !value;
        offset = value ? 120_000 : 0;
        if (online) await observe();
      },
      append(text) {
        appendFileSync(log, text);
      },
      rotate() {
        renameSync(log, log + ".old");
        writeFileSync(log, "new generation\n");
      },
      truncate() {
        writeFileSync(log, "x");
      },
      large() {
        writeFileSync(log, "🙂".repeat(100_000));
      },
      async close() {
        clearInterval(heartbeat);
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await registry.close();
        store.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    clearInterval(heartbeat);
    server?.closeAllConnections();
    server?.close();
    await registry?.close();
    store?.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
