// C15 private HTTPS composition; real SQLite enrollment, session and observation owners.
import { createServer, request as httpsRequest } from "node:https";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  openFleetStore,
  createEnrollmentService,
  createSessionService,
  createObservationService,
  createBrowserSecurity,
  createEnvironmentRoutes,
} from "../packages/fleet-control-plane/dist/index.js";

export async function createHarness() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "c15-ui-")));
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
  let store = openFleetStore(dir),
    enrollment,
    sessions,
    observations;
  let clock = Date.now();
  const now = () => new Date(clock);
  function compose() {
    observations = createObservationService(store, {
      now,
      invalidateProject: () => undefined,
    });
    enrollment = createEnrollmentService(store, {
      now,
      invalidateManagementAccess: (db, id) => {
        sessions.invalidate(db, id);
        return undefined;
      },
    });
    sessions = createSessionService(store, enrollment, {
      now,
      receiveObservation: observations.receiveObservation,
    });
  }
  compose();
  const counts = new Map();
  let routes,
    failReads = false;
  const server = createServer(
    {
      key: readFileSync(join(dir, "key.pem")),
      cert: readFileSync(join(dir, "cert.pem")),
    },
    async (req, res) => {
      try {
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (Buffer.byteLength(raw) > 8192) {
            res.writeHead(413);
            res.end();
            return;
          }
        }
        const result = await routes({
          method: req.method,
          pathname: req.url,
          origin: req.headers.origin,
          cookie: req.headers.cookie,
          csrfToken: req.headers["x-csrf-token"],
          ...(raw ? { body: JSON.parse(raw) } : {}),
        });
        res.writeHead(result?.status ?? 404, result?.headers);
        res.end(result?.body ?? "");
      } catch {
        res.writeHead(400);
        res.end();
      }
    }
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `https://127.0.0.1:${server.address().port}`;
  const browser = createBrowserSecurity({ publicOrigin: origin });
  routes = createEnvironmentRoutes(
    {
      createEnvironment: (...args) => enrollment.createEnvironment(...args),
      listEnvironments: (...args) => enrollment.listEnvironments(...args),
      regenerateEnrollment: (...args) =>
        enrollment.regenerateEnrollment(...args),
      revoke: (...args) => enrollment.revoke(...args),
    },
    browser,
    {
      publicOrigin: origin,
      now,
      projectCounts: async () => {
        if (failReads) throw Error("synthetic read fault");
        return counts;
      },
    }
  );
  return {
    origin,
    failReads(value) {
      failReads = value;
    },
    advance(ms) {
      clock += ms;
      sessions.expire();
    },
    restart() {
      store.close();
      store = openFleetStore(dir);
      compose();
      sessions.recoverAfterRestart();
    },
    environments: () => enrollment.listEnvironments(),
    async enroll(token) {
      return enrollment.enroll({
        protocolVersion: 1,
        requestId: randomUUID(),
        token,
      });
    },
    async signal(identity) {
      const opened = await sessions.openSession(identity, {
        protocolVersion: 1,
        requestId: randomUUID(),
        environmentId: identity.environmentId,
        agentId: identity.agentId,
        agentVersion: "fixture-v1",
        host: { hostname: "prepared-host", os: "linux" },
      });
      await sessions.observe(identity, {
        protocolVersion: 1,
        requestId: randomUUID(),
        environmentId: identity.environmentId,
        sessionId: opened.sessionId,
        sequence: 0,
        observedAt: now().toISOString(),
        inventory: {
          revisionId: randomUUID(),
          pageIndex: 0,
          pageCount: 1,
          projects: [],
        },
      });
      counts.set(identity.environmentId, 0);
    },
    async request(
      path,
      { method = "GET", body, cookie, csrfToken, sentOrigin = origin } = {}
    ) {
      return new Promise((resolve, reject) => {
        const req = httpsRequest(
          origin + path,
          {
            method,
            rejectUnauthorized: false,
            headers: {
              ...(body
                ? { "Content-Type": "application/json", Origin: sentOrigin }
                : {}),
              ...(cookie ? { Cookie: cookie } : {}),
              ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
            },
          },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (text += c));
            res.on("end", () =>
              resolve({
                status: res.statusCode,
                body: text,
                headers: res.headers,
              })
            );
          }
        );
        req.on("error", reject);
        req.end(body ? JSON.stringify(body) : undefined);
      });
    },
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
