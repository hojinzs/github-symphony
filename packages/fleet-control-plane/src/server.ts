import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Socket } from "node:net";
import { readFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { parseDocument } from "yaml";
import {
  ERROR_HTTP_STATUS,
  LIMITS,
  PROTOCOL_VERSION,
  ProtocolValidationError,
  claimRequestSchema,
  enrollmentRequestSchema,
  observationRequestSchema,
  pollRequestSchema,
  pollResponseSchema,
  resultRequestSchema,
  sessionRequestSchema,
  uuidSchema,
  type LifecycleCommand,
} from "@gh-symphony/management-protocol";
import { createBrowserSecurity } from "./browser-security.js";
import {
  createEnrollmentService,
  FleetError,
  type AgentCredential,
  type AgentSessionCredential,
} from "./enrollment.js";
import { createSessionService } from "./sessions.js";
import { createObservationService } from "./observations.js";
import { createCommandService } from "./commands.js";
import { createReadService } from "./reads.js";
import { createReadRoutes } from "./read-routes.js";
import { createCommandRoutes, commandProjectLinks } from "./command-routes.js";
import { createProjectRoutes } from "./project-routes.js";
import { createEnvironmentRoutes } from "./environment-routes.js";
import { createRunRoutes } from "./run-routes.js";
import { loadRunnableFleetConfig } from "./runnable-config.js";
import { openFleetStore } from "./store.js";

export interface FleetServer {
  close(): Promise<void>;
  publicOrigin: string;
  bindAddress: string;
  port: number;
}
const jsonHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
};
function invalid(message = "Invalid fleet request"): never {
  throw new FleetError("invalid_input", message);
}
function denied(): never {
  throw new FleetError(
    "unauthenticated",
    "Fleet authentication boundary rejected request"
  );
}

async function readBody(
  req: IncomingMessage,
  agent: boolean
): Promise<unknown> {
  const maximum = agent ? LIMITS.observationBodyBytes : 16 * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);
    if (size > maximum) invalid("Request body exceeds fleet byte limit");
    chunks.push(Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  const type = req.headers["content-type"]?.split(";")[0].trim().toLowerCase();
  if (type === "application/x-www-form-urlencoded" && !agent) {
    const form = new URLSearchParams(raw);
    for (const key of form.keys())
      if (form.getAll(key).length !== 1) invalid("Duplicate form field");
    return Object.fromEntries(form);
  }
  if (type !== "application/json")
    invalid("Use application/json or a browser form");
  try {
    const value: unknown = JSON.parse(raw);
    // JSON.parse validates JSON syntax; YAML's flow parser additionally rejects
    // duplicate decoded object keys (including nested/escaped spellings).
    const document = parseDocument(raw, { schema: "json", uniqueKeys: true });
    if (document.errors.length || document.warnings.length)
      invalid("Ambiguous JSON object");
    return value;
  } catch {
    return invalid("Malformed or duplicate-key JSON body");
  }
}

/** All transport, persistence and service lifecycle belongs to the fleet package. */
export async function startFleetServer(file: string): Promise<FleetServer> {
  const config = loadRunnableFleetConfig(file);
  let tls;
  if (config.transport.mode === "tls") {
    try {
      tls = {
        cert: readFileSync(config.transport.certFile),
        key: readFileSync(config.transport.keyFile),
        ...(config.transport.caFile
          ? { ca: readFileSync(config.transport.caFile) }
          : {}),
        minVersion: "TLSv1.2" as const,
      };
    } catch (error) {
      throw new Error(`Fleet TLS material: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }
  const store = openFleetStore(config.dataDir);
  let failedServer: ReturnType<typeof createHttpServer> | undefined;
  try {
    // Callbacks are invoked only after the full graph exists, on one connection.
    const enrollment = createEnrollmentService(store, {
      invalidateManagementAccess(database, id) {
        sessions.invalidate(database, id);
        return commands.invalidateEnvironment(database, id);
      },
    });
    const observations = createObservationService(store, {
      invalidateProject: (database, id) =>
        commands.invalidateProject(id, database),
    });
    const sessions = createSessionService(store, enrollment, {
      receiveObservation: observations.receiveObservation,
    });
    const peers = {
      resolveTarget: (database: DatabaseSync, id: string) =>
        database.isTransaction
          ? observations.resolveTarget(database, id)
          : store.transaction(() => observations.resolveTarget(database, id)),
      verifyAgent: (_database: unknown, identity: AgentSessionCredential) => {
        sessions.authenticateSession(identity);
        return true;
      },
    };
    const commands = createCommandService(store, { peers });
    const reads = createReadService(store, { peers });
    const browser = createBrowserSecurity(config);
    const routeOptions = {
      environments: enrollment.listEnvironments,
      links: commandProjectLinks,
    };
    const projectRoutes = createProjectRoutes(observations, routeOptions);
    const runRoutes = createRunRoutes(observations, browser, routeOptions);
    const environmentRoutes = createEnvironmentRoutes(enrollment, browser, {
      publicOrigin: config.publicOrigin,
      projectCounts: async () =>
        new Map(
          store.database
            .prepare(
              `SELECT r.environment_id, count(p.project_id) AS n
               FROM inventory_revisions r
               JOIN agent_sessions s ON s.environment_id=r.environment_id AND s.session_id=r.session_id
               LEFT JOIN observed_projects p ON p.environment_id=r.environment_id
                 AND p.agent_id=s.agent_id AND p.published=1 AND p.managed=1
               WHERE r.complete=1 GROUP BY r.environment_id`
            )
            .all()
            .map((row) => [String(row.environment_id), Number(row.n)])
        ),
    });
    const commandRoutes = createCommandRoutes(commands, browser, {
      async context(id) {
        const project = await observations.getProject(id);
        const environment =
          (await enrollment.listEnvironments()).find(
            (env) => env.environmentId === project.environmentId
          )?.name ?? project.environmentId;
        const active = (
          await commands.listCommands(id, { limit: 100 })
        ).items.some(
          (command) =>
            ["accepted", "executing"].includes(command.state) ||
            (command.state === "unknown" && !command.closure)
        );
        return {
          project,
          environment,
          disabledReasons: active
            ? {
                start:
                  "An active or unresolved command occupies this project slot.",
                stop: "An active or unresolved command occupies this project slot.",
              }
            : {},
        };
      },
    });
    const readRoutes = createReadRoutes(reads, browser);
    const shutdown = new AbortController();
    function credential(
      req: IncomingMessage,
      environmentId: string
    ): AgentCredential {
      uuidSchema.parse(environmentId);
      const auth = req.headers.authorization;
      if (typeof auth !== "string" || !/^Bearer [A-Za-z0-9_-]{43}$/.test(auth))
        return denied();
      const row = store.database
        .prepare(
          "SELECT agent_id FROM agent_credentials WHERE environment_id=?"
        )
        .get(environmentId);
      if (!row) return denied();
      const identity = {
        environmentId,
        agentId: String(row.agent_id),
        credential: auth.slice(7),
      };
      enrollment.authenticate(identity);
      return identity;
    }
    async function agentRoute(
      req: IncomingMessage,
      url: URL,
      body: unknown,
      signal: AbortSignal
    ): Promise<unknown> {
      // Agent routes never exchange cookies/CSRF actors for agent credentials.
      if (req.headers.origin !== undefined || req.headers.cookie !== undefined)
        return denied();
      if (url.pathname === "/api/v1/agents/enroll" && req.method === "POST")
        return enrollment.enroll(enrollmentRequestSchema.parse(body));
      if (url.pathname === "/api/v1/agents/sessions" && req.method === "POST") {
        if (
          (body as { protocolVersion?: unknown })?.protocolVersion !==
          PROTOCOL_VERSION
        )
          throw new FleetError(
            "unsupported_protocol",
            "Unsupported management protocol"
          );
        const request = sessionRequestSchema.parse(body);
        return sessions.openSession(
          credential(req, request.environmentId),
          request
        );
      }
      if (
        url.pathname === "/api/v1/agents/observations" &&
        req.method === "POST"
      ) {
        const request = observationRequestSchema.parse(body);
        return sessions.observe(
          credential(req, request.environmentId),
          request
        );
      }
      const claim = /^\/api\/v1\/agents\/commands\/([^/]+)\/claim$/.exec(
        url.pathname
      );
      if (claim && req.method === "POST") {
        const request = claimRequestSchema.parse(body);
        if (request.commandId !== claim[1])
          invalid("Command path does not match envelope");
        return commands.claim(
          {
            ...credential(req, request.environmentId),
            sessionId: request.sessionId,
          },
          request
        );
      }
      if (url.pathname === "/api/v1/agents/results" && req.method === "POST") {
        const request = resultRequestSchema.parse(body);
        const identity = {
          ...credential(req, request.environmentId),
          sessionId: request.sessionId,
        };
        sessions.authenticateSession(identity);
        if (request.result.kind === "read")
          return reads.publishResult(identity, request);
        const command = await commands.getCommand(request.result.commandId);
        if (command.owner && command.owner.sessionId !== identity.sessionId)
          commands.transferOwnership(identity, command.commandId);
        return commands.publishResult(identity, request);
      }
      if (url.pathname === "/api/v1/agents/poll" && req.method === "GET") {
        if (
          [...url.searchParams.keys()].some(
            (key) => url.searchParams.getAll(key).length !== 1
          )
        )
          invalid();
        const query = Object.fromEntries(url.searchParams);
        const request = pollRequestSchema.parse({
          ...query,
          protocolVersion: Number(query.protocolVersion),
        });
        const identity = {
          ...credential(req, request.environmentId),
          sessionId: request.sessionId,
        };
        const deadline = Date.now() + LIMITS.pollTimeoutMs;
        while (true) {
          sessions.authenticateSession(identity);
          commands.recover();
          const queued: LifecycleCommand[] = [];
          const rows = store.database
            .prepare(
              "SELECT command_id FROM lifecycle_commands WHERE environment_id=? AND session_id=? AND state='accepted' ORDER BY submitted_at,command_id LIMIT ?"
            )
            .all(
              identity.environmentId,
              identity.sessionId,
              LIMITS.activeCommandsPerAgent
            );
          for (const row of rows) {
            const c = await commands.getCommand(String(row.command_id));
            if (c.state === "accepted")
              queued.push({
                commandId: c.commandId,
                projectId: c.projectId,
                environmentId: c.environmentId,
                localProjectId: c.localProjectId,
                sessionId: c.sessionId,
                operation: c.operation,
                actor: c.actor,
                idempotencyKey: c.idempotencyKey,
                submittedAt: c.submittedAt,
                expiresAt: c.expiresAt,
              });
          }
          const pending = reads.poll(identity);
          if (queued.length || pending.length || Date.now() >= deadline)
            return pollResponseSchema.parse({
              ...request,
              commands: queued,
              reads: pending,
            });
          await delay(Math.min(250, deadline - Date.now()), undefined, {
            signal,
          });
        }
      }
      throw new FleetError("not_found", "Unknown agent route or method");
    }
    async function handle(req: IncomingMessage, res: ServerResponse) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      const signal = AbortSignal.any([shutdown.signal, controller.signal]);
      res.once("close", abort);
      const deadline = setTimeout(() => {
        controller.abort();
        res.destroy();
      }, 30_000);
      deadline.unref();
      const sendJson = (status: number, body: unknown) => {
        res.writeHead(status, jsonHeaders);
        res.end(JSON.stringify(body));
      };
      try {
        if (shutdown.signal.aborted) {
          sendJson(503, { status: "stopping" });
          return;
        }
        if (req.headers.host !== new URL(config.publicOrigin).host) denied();
        if (!req.url?.startsWith("/") || req.url.startsWith("//")) invalid();
        const url = new URL(req.url, config.publicOrigin);
        const agent = url.pathname.startsWith("/api/v1/agents/");
        if (
          !agent &&
          req.headers.origin !== undefined &&
          req.headers.origin !== config.publicOrigin
        )
          denied();
        if (req.method === "GET" && url.pathname === "/healthz") {
          sendJson(200, { status: "ready" });
          return;
        }
        if (req.method === "GET" && url.pathname === "/") {
          res.writeHead(303, { ...jsonHeaders, Location: "/environments" });
          res.end();
          return;
        }
        sessions.expire();
        const body = await readBody(req, agent);
        if (agent) {
          sendJson(200, await agentRoute(req, url, body, signal));
          return;
        }
        const request = {
          method: req.method ?? "GET",
          pathname: url.pathname + url.search,
          origin: req.headers.origin,
          cookie: req.headers.cookie,
          csrfToken: req.headers["x-csrf-token"],
          body,
        };
        const page =
          (await environmentRoutes(request)) ??
          (await commandRoutes(request)) ??
          (await projectRoutes(request)) ??
          (await runRoutes(request));
        if (page) {
          res.writeHead(page.status, page.headers);
          res.end(page.body);
          return;
        }
        const read = await readRoutes(request);
        if (read) {
          res.writeHead(read.status, { ...jsonHeaders, ...read.headers });
          res.end(JSON.stringify(read.body));
          return;
        }
        sendJson(404, {
          error: {
            code: "not_found",
            message: "Unknown fleet route",
            requestId: randomUUID(),
          },
        });
      } catch (error) {
        if (signal.aborted || res.destroyed) {
          if (!res.destroyed) res.destroy();
          return;
        }
        const fleet = error instanceof FleetError ? error : undefined;
        const invalidInput = error instanceof ProtocolValidationError;
        sendJson(
          fleet ? ERROR_HTTP_STATUS[fleet.code] : invalidInput ? 400 : 500,
          {
            error: {
              code:
                fleet?.code ??
                (invalidInput ? "invalid_input" : "internal_error"),
              message:
                fleet?.message ??
                (invalidInput
                  ? "Invalid management protocol request"
                  : "Fleet request failed"),
              requestId: randomUUID(),
            },
          }
        );
      } finally {
        clearTimeout(deadline);
        res.removeListener("close", abort);
      }
    }
    const active = new Set<Promise<void>>();
    const listener = (req: IncomingMessage, res: ServerResponse) => {
      const task = handle(req, res).catch(() => {
        res.destroy();
      });
      active.add(task);
      void task.finally(() => active.delete(task));
    };
    let server;
    try {
      server = tls
        ? createHttpsServer(tls, listener)
        : createHttpServer(listener);
    } catch (error) {
      throw new Error(`Fleet TLS initialization: ${(error as Error).message}`, {
        cause: error,
      });
    }
    failedServer = server;
    // HTTP connection tracking starts after TLS negotiation. Track raw sockets
    // as well so an unfinished handshake cannot outlive the shutdown deadline.
    const sockets = new Set<Socket>();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.bindAddress, () => {
        server.removeListener("error", reject);
        resolve();
      });
    }).catch((error: unknown) => {
      throw new Error(
        `Fleet bind ${config.bindAddress}:${config.port}: ${(error as Error).message}. Check address availability; no port fallback.`,
        { cause: error }
      );
    });
    sessions.recoverAfterRestart();
    commands.recover();
    reads.recover();
    let closing: Promise<void> | undefined;
    return {
      publicOrigin: config.publicOrigin,
      bindAddress: config.bindAddress,
      port: config.port,
      close() {
        closing ??= (async () => {
          shutdown.abort();
          const force = setTimeout(() => {
            for (const socket of sockets) socket.destroy();
            server.closeAllConnections();
          }, 5_000);
          force.unref();
          try {
            await new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve()))
            );
            await Promise.allSettled(active);
          } finally {
            clearTimeout(force);
            store.close();
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    if (failedServer?.listening) {
      failedServer.closeAllConnections();
      await new Promise<void>((resolve) =>
        failedServer!.close(() => resolve())
      );
    }
    store.close();
    throw error;
  }
}

/** Foreground signal handling is shared by every CLI route into this package. */
export async function runFleetControlPlane(file: string): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let server: FleetServer | undefined;
  try {
    server = await startFleetServer(file);
    process.stdout.write(
      JSON.stringify({
        event: "fleet-ready",
        publicOrigin: server.publicOrigin,
        bindAddress: server.bindAddress,
        port: server.port,
        healthPath: "/healthz",
      }) + "\n"
    );
    if (!controller.signal.aborted)
      await new Promise<void>((resolve) =>
        controller.signal.addEventListener("abort", () => resolve(), {
          once: true,
        })
      );
  } finally {
    await server?.close();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
