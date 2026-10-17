// C17 private HTTPS fixture: real C04/C05/C06/C07 services and protocol records.
import { createServer, request as httpsRequest } from "node:https";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  openFleetStore,
  createEnrollmentService,
  createSessionService,
  createObservationService,
  createCommandService,
  createBrowserSecurity,
  createCommandRoutes,
  createProjectRoutes,
  commandProjectLinks,
} from "../packages/fleet-control-plane/dist/index.js";
export async function createHarness() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "c17-ui-")));
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
      "-subj",
      "/CN=localhost",
      "-days",
      "1",
    ],
    { stdio: "ignore" }
  );
  const store = openFleetStore(dir);
  let commandClock = new Date();
  let commands;
  const observations = createObservationService(store, {
    invalidateProject: (db, id) => commands.invalidateProject(id, db),
  });
  let sessions;
  const enrollment = createEnrollmentService(store, {
    invalidateManagementAccess: (db, id) => sessions.invalidate(db, id),
  });
  sessions = createSessionService(store, enrollment, {
    receiveObservation: observations.receiveObservation,
  });
  commands = createCommandService(store, {
    now: () => commandClock,
    peers: {
      resolveTarget: observations.resolveTarget,
      verifyAgent: (_db, identity) => {
        sessions.authenticateSession(identity);
        return true;
      },
    },
  });
  const token = await enrollment.createEnvironment({ name: "lab-linux" });
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
    agentVersion: "fixture",
    host: { hostname: "lab-linux", os: "linux" },
  });
  const identity = { ...credential, sessionId: session.sessionId };
  const localIds = [
    "interactive",
    "accepted",
    "executing",
    "succeeded",
    "failed",
    "expired",
    "unknown",
    "superseded",
    "closed",
    "invalid",
  ];
  const ids = Object.fromEntries(
    observations
      .identifyProjects(credential.environmentId, localIds)
      .map((id, i) => [localIds[i], id])
  );
  const stamp = new Date().toISOString();
  const projects = localIds.map((name) => ({
    projectId: ids[name],
    localProjectId: name,
    displayName: name === "interactive" ? "api-platform" : name,
    canonicalPath: "/home/operator/prepared/" + name,
    cliVersion: "fixture",
    validation:
      name === "invalid"
        ? {
            state: "invalid",
            diagnostic: {
              code: "project_invalid",
              message: "Workflow invalid",
            },
          }
        : { state: "valid" },
    process: {
      state: "running",
      observedAt: stamp,
      identity: "replacement-42",
      pid: 42,
    },
    observedAt: stamp,
    snapshotObservedAt: stamp,
    snapshot: { health: "healthy", summary: { activeRuns: 2 }, retryQueue: [] },
    runs: [],
  }));
  await sessions.observe(credential, {
    protocolVersion: 1,
    requestId: randomUUID(),
    environmentId: credential.environmentId,
    sessionId: session.sessionId,
    sequence: 0,
    observedAt: stamp,
    inventory: {
      revisionId: randomUUID(),
      pageIndex: 0,
      pageCount: 1,
      projects,
    },
  });
  const envelope = () => ({
    protocolVersion: 1,
    environmentId: credential.environmentId,
    sessionId: session.sessionId,
    requestId: randomUUID(),
  });
  const records = {};
  // Advance only the C07 authoritative command clock for deterministic timeouts;
  // real C05 heartbeat time is not advanced or represented as native OS evidence.
  for (const name of localIds.filter(
    (n) => !["interactive", "invalid"].includes(n)
  )) {
    commandClock = new Date(stamp);
    const row = await commands.submitCommand(ids[name], name, {
      operation: "stop",
    });
    records[name] = row.commandId;
    if (name === "accepted") continue;
    if (name === "expired") {
      commandClock = new Date(Date.parse(stamp) + 30_000);
      await commands.getCommand(row.commandId);
      continue;
    }
    await commands.claim(identity, { ...envelope(), commandId: row.commandId });
    if (name === "executing") continue;
    if (["unknown", "closed"].includes(name)) {
      commandClock = new Date(Date.parse(stamp) + 60_001);
      await commands.getCommand(row.commandId);
      if (name === "closed")
        await commands.closeUnresolved(row.commandId, {
          acknowledged: true,
          reason: "Inspected host; outcome remains uncertain",
        });
    } else {
      await commands.publishResult(identity, {
        ...envelope(),
        result: {
          kind: "command",
          commandId: row.commandId,
          state: name === "succeeded" ? "succeeded" : "failed",
          observedAt: stamp,
          evidence: {
            verified: true,
            process: { state: "stopped", observedAt: stamp },
          },
          ...(name === "superseded"
            ? {
                diagnostic: {
                  code: "superseded_target",
                  message: "Original identity was replaced",
                },
              }
            : name === "failed"
              ? {
                  diagnostic: {
                    code: "process_unverified",
                    message: "Exit not verified",
                  },
                }
              : {}),
        },
      });
    }
  }
  commandClock = new Date(stamp);
  let routes;
  const server = createServer(
    {
      key: readFileSync(join(dir, "key.pem")),
      cert: readFileSync(join(dir, "cert.pem")),
    },
    async (req, res) => {
      try {
        let body = {};
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (Buffer.byteLength(raw) > 16384) {
            res.writeHead(413);
            res.end();
            return;
          }
        }
        const params = new URLSearchParams(raw);
        if ([...params.keys()].some((key) => params.getAll(key).length !== 1)) {
          res.writeHead(400);
          res.end();
          return;
        }
        body = Object.fromEntries(params);
        const result = await routes({
          method: req.method,
          pathname: req.url,
          origin: req.headers.origin,
          cookie: req.headers.cookie,
          body,
        });
        res.writeHead(result?.status ?? 404, result?.headers);
        res.end(result?.body ?? "");
      } catch {
        res.writeHead(500);
        res.end();
      }
    }
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `https://127.0.0.1:${server.address().port}`;
  const browser = createBrowserSecurity({ publicOrigin: origin });
  let disabledReason;
  let unavailable = false;
  const commandRoutes = createCommandRoutes(commands, browser, {
    context: async (id) => {
      if (unavailable) throw new Error("fixture transport interruption");
      const project = await observations.getProject(id);
      const active = (
        await commands.listCommands(id, { limit: 100 })
      ).items.find(
        (c) =>
          ["accepted", "executing"].includes(c.state) ||
          (c.state === "unknown" && !c.closure)
      );
      const reason =
        disabledReason ??
        (active
          ? "An active or unresolved command occupies this project slot."
          : undefined);
      return {
        project,
        environment: "lab-linux",
        disabledReasons: reason ? { start: reason, stop: reason } : {},
      };
    },
  });
  const projectRoutes = createProjectRoutes(observations, {
    environments: enrollment.listEnvironments,
    links: commandProjectLinks,
  });
  routes = async (request) =>
    (await commandRoutes(request)) ?? (await projectRoutes(request));
  async function request(
    path,
    { method = "GET", body, cookie, origin: sentOrigin = origin } = {}
  ) {
    return await new Promise((resolve, reject) => {
      const req = httpsRequest(
        origin + path,
        {
          method,
          rejectUnauthorized: false,
          headers: {
            ...(cookie ? { cookie } : {}),
            ...(method === "POST"
              ? {
                  Origin: sentOrigin,
                  "Content-Type": "application/x-www-form-urlencoded",
                }
              : {}),
          },
        },
        (res) => {
          let text = "";
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: text,
            })
          );
        }
      );
      req.on("error", reject);
      req.end(body ? new URLSearchParams(body).toString() : undefined);
    });
  }
  return {
    origin,
    ids,
    records,
    commands,
    observations,
    store,
    request,
    setDisabled: (reason) => (disabledReason = reason),
    setUnavailable: (value) => (unavailable = value),
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
