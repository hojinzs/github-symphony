// Independent C05/C07 peer fixture for C04. This is not a shipped fleet HTTP server.
import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  resolveFleetConfig,
  openFleetStore,
  createEnrollmentService,
  createBrowserSecurity,
} from "../packages/fleet-control-plane/dist/index.js";
import {
  ERROR_HTTP_STATUS,
  sessionRequestSchema,
  observationRequestSchema,
} from "../packages/management-protocol/dist/index.js";

let time = Number(process.env.FLEET_FIXTURE_TIME);
const store = openFleetStore(process.env.FLEET_FIXTURE_DATA);
store.database.exec(`
  CREATE TABLE IF NOT EXISTS fixture_sessions (
    environment_id TEXT, agent_id TEXT, session_id TEXT PRIMARY KEY, current INTEGER
  );
  CREATE TABLE IF NOT EXISTS fixture_commands (
    environment_id TEXT, id TEXT PRIMARY KEY, state TEXT
  );
`);
const enrollment = createEnrollmentService(store, {
  now: () => new Date(time),
  invalidateManagementAccess(database, environmentId) {
    database
      .prepare(
        "UPDATE fixture_sessions SET current = 0 WHERE environment_id = ?"
      )
      .run(environmentId);
    database
      .prepare(
        "UPDATE fixture_commands SET state = 'expired' WHERE environment_id = ? AND state = 'accepted'"
      )
      .run(environmentId);
    return undefined;
  },
});
const verifySession = (database, identity) =>
  Boolean(
    database
      .prepare(
        "SELECT session_id FROM fixture_sessions WHERE environment_id = ? AND agent_id = ? AND session_id = ? AND current = 1"
      )
      .get(identity.environmentId, identity.agentId, identity.sessionId)
  );
let security;
function respond(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(body));
}
async function json(request) {
  const parts = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 64 * 1024) throw new Error("Fixture body exceeds limit");
    parts.push(chunk);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
}
const credential = (request) =>
  /^Bearer ([A-Za-z0-9_-]+)$/.exec(request.headers.authorization ?? "")?.[1] ??
  "";
const server = createServer(
  {
    key: readFileSync(process.env.FLEET_FIXTURE_KEY),
    cert: readFileSync(process.env.FLEET_FIXTURE_CERT),
  },
  async (request, response) => {
    try {
      const path = new URL(request.url, "https://fixture.invalid").pathname;
      if (path.startsWith("/api/v1/agents/")) {
        const input = await json(request);
        if (path === "/api/v1/agents/enroll") {
          respond(response, 200, await enrollment.enroll(input));
          return;
        }
        if (path === "/api/v1/agents/sessions") {
          const parsed = sessionRequestSchema.parse(input);
          enrollment.authenticate({
            ...parsed,
            credential: credential(request),
          });
          const sessionId = randomUUID();
          store.transaction(() => {
            store.database
              .prepare(
                "UPDATE fixture_sessions SET current = 0 WHERE environment_id = ?"
              )
              .run(parsed.environmentId);
            store.database
              .prepare("INSERT INTO fixture_sessions VALUES (?, ?, ?, 1)")
              .run(parsed.environmentId, parsed.agentId, sessionId);
          });
          respond(response, 200, {
            protocolVersion: 1,
            requestId: parsed.requestId,
            environmentId: parsed.environmentId,
            sessionId,
            expiresAt: new Date(time + 60_000).toISOString(),
          });
          return;
        }
        if (path === "/api/v1/agents/observations") {
          const parsed = observationRequestSchema.parse(input);
          const session = store.database
            .prepare(
              "SELECT agent_id FROM fixture_sessions WHERE session_id = ?"
            )
            .get(parsed.sessionId);
          enrollment.recordAuthenticatedSignal(
            {
              environmentId: parsed.environmentId,
              sessionId: parsed.sessionId,
              agentId: session?.agent_id ?? randomUUID(),
              credential: credential(request),
            },
            verifySession
          );
          respond(response, 200, {
            protocolVersion: 1,
            requestId: parsed.requestId,
            environmentId: parsed.environmentId,
            sessionId: parsed.sessionId,
            receivedAt: new Date(time).toISOString(),
          });
          return;
        }
        respond(response, 404, {});
        return;
      }
      // Every browser path uses the actor resolver. No forwarded-origin or CORS support.
      security.resolveActor({
        method: request.method,
        origin: request.headers.origin,
        cookie: request.headers.cookie,
        csrfToken: request.headers["x-csrf-token"],
      });
      if (request.method === "GET" && path === "/session") {
        const session = security.issueSession();
        respond(
          response,
          200,
          { csrfToken: session.csrfToken, expiresAt: session.expiresAt },
          { "Set-Cookie": session.setCookie }
        );
      } else if (request.method === "GET" && path === "/api/v1/environments") {
        respond(response, 200, await enrollment.listEnvironments());
      } else if (request.method === "POST" && path === "/api/v1/environments") {
        respond(
          response,
          201,
          await enrollment.createEnvironment(await json(request))
        );
      } else if (
        request.method === "POST" &&
        /^\/api\/v1\/environments\/[^/]+\/(enrollment|revoke)$/.test(path)
      ) {
        const [, , , , id, operation] = path.split("/");
        respond(
          response,
          200,
          operation === "revoke"
            ? (await enrollment.revoke(id), {})
            : await enrollment.regenerateEnrollment(id)
        );
      } else if (request.method === "POST" && path === "/fixture/advance") {
        time += (await json(request)).milliseconds;
        respond(response, 200, { time });
      } else if (request.method === "GET" && path === "/fixture/audits") {
        respond(
          response,
          200,
          store.database
            .prepare(
              "SELECT actor, target, operation, request_id, occurred_at, outcome FROM audit_records ORDER BY id"
            )
            .all()
        );
      } else if (request.method === "POST" && path === "/fixture/commands") {
        const input = await json(request);
        store.database
          .prepare("INSERT INTO fixture_commands VALUES (?, ?, 'accepted')")
          .run(input.environmentId, randomUUID());
        respond(response, 201, {});
      } else if (request.method === "GET" && path === "/fixture/commands") {
        respond(
          response,
          200,
          store.database.prepare("SELECT state FROM fixture_commands").all()
        );
      } else {
        respond(response, 404, {});
      }
    } catch (error) {
      const known = Object.hasOwn(ERROR_HTTP_STATUS, error.code);
      respond(response, known ? ERROR_HTTP_STATUS[error.code] : 500, {
        error: {
          code: known ? error.code : "invalid_input",
          message: known ? error.message : "Fixture operation failed",
          requestId: randomUUID(),
        },
      });
    }
  }
);
server.listen(Number(process.env.FLEET_FIXTURE_PORT ?? 0), "127.0.0.1", () => {
  const config = resolveFleetConfig({
    dataDir: process.env.FLEET_FIXTURE_DATA,
    publicOrigin: `https://127.0.0.1:${server.address().port}`,
  });
  security = createBrowserSecurity(config, { now: () => time });
  console.log(JSON.stringify({ origin: config.publicOrigin }));
});
process.on("SIGTERM", () => {
  server.close(() => {
    store.close();
    process.exit(0);
  });
  server.closeAllConnections();
});
