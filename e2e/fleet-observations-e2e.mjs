// C06 black-box composition: independent TLS peer process, actual C04/C05/C06/C07
// services, actual bundled publisher/local reader, and real SQLite. Fixture routes
// exercise library boundaries; they are not the production fleet HTTP server.
import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createServer, request as httpsRequest } from "node:https";
import { once } from "node:events";
import {
  AgentRegistry,
  createInventorySnapshot,
  createAgentTransport,
  observationPages,
} from "../packages/cli/dist/management-agent.js";
import { inspectLocalProject } from "../packages/cli/dist/management-local.js";
import {
  aggregateProjectSchema,
  pageSchema,
  ERROR_HTTP_STATUS,
  LIMITS,
} from "../packages/management-protocol/dist/index.js";
const repository = fileURLToPath(new URL("../", import.meta.url));
const artifacts = process.env.C06_FLEET_ARTIFACT_ROOT ?? repository;
const {
  openFleetStore,
  createEnrollmentService,
  createSessionService,
  createObservationService,
  createCommandService,
} = await import(
  pathToFileURL(join(artifacts, "packages/fleet-control-plane/dist/index.js"))
);
const self = fileURLToPath(import.meta.url);

async function serve(root) {
  const store = openFleetStore(join(root, "fleet"));
  let clock = Date.now(),
    fault = false,
    sessions,
    commands;
  const now = () => new Date(clock);
  const observations = createObservationService(store, {
    now,
    invalidateProject(db, id) {
      commands.invalidateProject(id, db);
      if (fault) throw new Error("fixture invalidation fault");
      return undefined;
    },
  });
  const enrollment = createEnrollmentService(store, {
    now,
    invalidateManagementAccess(db, id) {
      commands.invalidateEnvironment(db, id);
      sessions.invalidate(db, id);
      return undefined;
    },
  });
  sessions = createSessionService(store, enrollment, {
    now,
    receiveObservation: observations.receiveObservation,
  });
  commands = createCommandService(store, {
    now,
    peers: {
      resolveTarget: observations.resolveTarget,
      verifyAgent(_db, identity) {
        sessions.authenticateSession(identity);
        return true;
      },
    },
  });
  sessions.recoverAfterRestart();
  const server = createServer(
    {
      key: readFileSync(join(root, "key")),
      cert: readFileSync(join(root, "cert")),
    },
    async (req, res) => {
      try {
        const parts = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > LIMITS.observationBodyBytes)
            throw Object.assign(new Error("limit"), { code: "invalid_input" });
          parts.push(chunk);
        }
        const input = JSON.parse(Buffer.concat(parts).toString() || "{}");
        const path = new URL(req.url, "https://fixture").pathname;
        // IPC initializes credentials; authenticated agent routes never accept a browser credential.
        const agent = store.database
          .prepare(
            "SELECT agent_id FROM agent_credentials WHERE environment_id=?"
          )
          .get(input.environmentId ?? "");
        const identity = {
          ...input,
          agentId: input.agentId ?? agent?.agent_id,
          credential:
            /^Bearer ([A-Za-z0-9_-]+)$/.exec(
              req.headers.authorization ?? ""
            )?.[1] ?? "",
        };
        let result;
        if (path === "/api/v1/agents/sessions")
          result = await sessions.openSession(identity, input);
        else if (path === "/api/v1/agents/observations")
          result = await sessions.observe(identity, input);
        else if (path === "/fixture/identities") {
          sessions.authenticateSession(identity);
          const ids = observations.identifyProjects(
            input.environmentId,
            input.localProjectIds
          );
          result = ids.map((id, i) => ({
            projectId: id,
            environmentId: input.environmentId,
            localProjectId: input.localProjectIds[i],
          }));
        } else throw Object.assign(new Error("missing"), { code: "not_found" });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (error) {
        const code = error.code ?? "invalid_input";
        res.writeHead(ERROR_HTTP_STATUS[code] ?? 500, {
          "content-type": "application/json",
        });
        res.end(
          JSON.stringify({
            error: {
              code,
              message: "Fixture request rejected",
              requestId: randomUUID(),
            },
          })
        );
      }
    }
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.send({ origin: `https://localhost:${server.address().port}` });
  process.on("message", async ({ id, method, args }) => {
    try {
      let value;
      if (method === "enroll") {
        const token = await enrollment.createEnvironment({ name: args[0] });
        value = await enrollment.enroll({
          protocolVersion: 1,
          requestId: randomUUID(),
          token: token.token,
        });
      } else if (method === "list")
        value = await observations.listProjects(...args);
      else if (method === "get") value = await observations.getProject(...args);
      else if (method === "summary") value = observations.summary();
      else if (method === "environments")
        value = await enrollment.listEnvironments();
      else if (method === "expire") {
        clock += 31_000;
        sessions.expire();
        value = true;
      } else if (method === "revoke") {
        await enrollment.revoke(...args);
        value = true;
      } else if (method === "replace") {
        const token = await enrollment.regenerateEnrollment(args[0]);
        value = await enrollment.enroll({
          protocolVersion: 1,
          requestId: randomUUID(),
          token: token.token,
        });
      } else if (method === "submit")
        value = await commands.submitCommand(...args);
      else if (method === "command") value = await commands.getCommand(...args);
      else if (method === "fault") {
        fault = args[0];
        value = true;
      } else throw new Error("Unknown fixture RPC");
      process.send({ id, value });
    } catch (error) {
      process.send({ id, error: { code: error.code, message: error.message } });
    }
  });
  process.on("disconnect", () =>
    server.close(() => {
      store.close();
      process.exit(0);
    })
  );
}
if (process.argv[2] === "--peer") await serve(process.argv[3]);
else {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "c06-blackbox-")));
  let child,
    registry,
    origin,
    identity,
    sessionId,
    sequence = 0;
  let reached = 0;
  function check(condition, label) {
    console.log(`reached: ${label}`);
    reached++;
    assert.ok(condition, label);
  }
  async function start() {
    child = fork(self, ["--peer", root], {
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    const message = await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => {
        throw new Error("Peer startup exited");
      }),
    ]);
    origin = message[0].origin;
  }
  async function rpc(method, ...args) {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.off("message", receive);
        reject(new Error("RPC timeout"));
      }, 10_000);
      function receive(message) {
        if (message.id !== id) return;
        clearTimeout(timer);
        child.off("message", receive);
        message.error
          ? reject(
              Object.assign(new Error(message.error.message), message.error)
            )
          : resolve(message.value);
      }
      child.on("message", receive);
      child.send({ id, method, args });
    });
  }
  async function stop() {
    const exited = once(child, "exit");
    child.disconnect();
    await exited;
    child = undefined;
  }
  function client() {
    return createAgentTransport({
      serverOrigin: origin,
      ca: readFileSync(join(root, "cert")),
      identity: () => ({ ...identity, serverOrigin: origin }),
    });
  }
  async function open() {
    const session = await client().openSession({
      protocolVersion: 1,
      requestId: randomUUID(),
      environmentId: identity.environmentId,
      agentId: identity.agentId,
      agentVersion: "c06-fixture",
      host: {
        hostname: "Fixture",
        os: process.platform === "darwin" ? "darwin" : "linux",
      },
    });
    sessionId = session.sessionId;
    sequence = 0;
  }
  const envelope = () => ({
    protocolVersion: 1,
    requestId: randomUUID(),
    environmentId: identity.environmentId,
    sessionId,
  });
  async function identities(environmentId, localProjectIds) {
    const url = new URL("/fixture/identities", origin);
    const body = JSON.stringify({
      ...envelope(),
      environmentId,
      agentId: identity.agentId,
      localProjectIds,
    });
    return new Promise((resolve, reject) => {
      const req = httpsRequest(
        url,
        {
          method: "POST",
          ca: readFileSync(join(root, "cert")),
          headers: {
            authorization: `Bearer ${identity.credential}`,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
          },
        },
        (res) => {
          const parts = [];
          res.on("data", (p) => parts.push(p));
          res.on("end", () =>
            res.statusCode === 200
              ? resolve(JSON.parse(Buffer.concat(parts).toString()))
              : reject(
                  Object.assign(new Error("Identity negotiation failed"), {
                    code: JSON.parse(Buffer.concat(parts).toString()).error
                      ?.code,
                  })
                )
          );
        }
      );
      req.setTimeout(10_000, () => req.destroy(new Error("Identity timeout")));
      req.on("error", reject);
      req.end(body);
    });
  }
  async function send(
    projects,
    revisionId = randomUUID(),
    pageIndex = 0,
    pageCount = 1
  ) {
    const request = {
      ...envelope(),
      sequence: sequence++,
      observedAt: "2099-01-01T00:00:00Z",
      inventory: { revisionId, pageIndex, pageCount, projects },
    };
    return client().observe(request);
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
    await start();
    identity = await rpc("enroll", "First host");
    await open();
    await send([]);
    check(
      (await rpc("environments"))[0].connection === "online" &&
        (await rpc("list")).items.length === 0,
      "CP21 empty inventory is online"
    );
    registry = await AgentRegistry.open(join(root, "agent"));
    await registry.saveIdentity(origin, identity);
    const folder = join(root, "prepared");
    mkdirSync(folder);
    await registry.add(folder);
    const reader = {
      inspect: (project) =>
        inspectLocalProject(join(root, "cli-config"), project, {}),
    };
    const snapshot = createInventorySnapshot({
      reader,
      cliVersion: "fixture",
      resolveIdentities: identities,
    });
    const local = await snapshot(registry, new AbortController().signal);
    await send(local);
    check(
      (await rpc("get", local[0].projectId)).observation.validation.state ===
        "invalid",
      "CP03 invalid prepared folder remains visible"
    );
    const scope = {
      adapter: "github",
      bindingId: "board",
      repository: "owner/repo",
      activeStates: ["Ready", "In progress"],
      includeLabels: ["feature"],
      excludeLabels: [],
    };
    const a = {
      ...local[0],
      validation: { state: "valid" },
      process: {
        state: "running",
        observedAt: "2099-01-01T00:00:00Z",
        identity: "opaque",
        pid: 42,
      },
      snapshot: { trackerScope: scope },
      snapshotObservedAt: "2099-01-01T00:00:00Z",
    };
    const [binding] = await identities(identity.environmentId, [
      "typed-second-project",
    ]);
    const b = { ...a, ...binding, displayName: "Typed fixture" };
    delete b.environmentId;
    await send([a, b]);
    const revision = randomUUID();
    await send(
      [{ ...a, process: { state: "stopped", observedAt: a.observedAt } }],
      revision,
      0,
      2
    );
    check(
      (await rpc("get", b.projectId)).managed &&
        (await rpc("get", a.projectId)).observation.process.state === "stopped",
      "partial revision retains unseen membership and advances status"
    );
    let rejected = false;
    try {
      await send([a], revision, 1, 2);
    } catch (error) {
      rejected = error.code === "invalid_input";
    }
    check(rejected, "duplicate cross-page identity rejected");
    await send([], revision, 1, 2);
    check(
      !(await rpc("get", b.projectId)).managed,
      "complete revision revokes removed membership"
    );
    await send([a]);
    const command = await rpc("submit", a.projectId, "c06-start", {
      operation: "start",
    });
    await rpc("fault", true);
    try {
      await send([]);
    } catch {
      /* expected peer fault */
    }
    check(
      (await rpc("command", command.commandId)).state === "accepted" &&
        (await rpc("get", a.projectId)).managed,
      "peer fault rolls back inventory and command invalidation"
    );
    await rpc("fault", false);
    await send([]);
    check(
      (await rpc("command", command.commandId)).state === "expired",
      "C07 complete removal expires unclaimed command"
    );
    await send([a]);
    await send([
      {
        ...a,
        snapshot: undefined,
        snapshotObservedAt: undefined,
        snapshotError: {
          code: "log_unavailable",
          message: "Fixture read failed",
        },
      },
    ]);
    const retained = aggregateProjectSchema.parse(
      await rpc("get", a.projectId)
    );
    check(
      retained.snapshotStale &&
        retained.observation.snapshotObservedAt === a.snapshotObservedAt &&
        retained.observation.snapshot?.trackerScope?.bindingId === "board",
      "failed snapshot retains last successful data"
    );
    // Independent fixture metadata stresses the real bounded agent page publisher.
    const large = {
      ...a,
      snapshot: { redactedFixture: "x".repeat(2_200_000) },
    };
    const pages = observationPages(
      envelope(),
      [
        large,
        { ...large, projectId: b.projectId, localProjectId: b.localProjectId },
      ],
      sequence
    );
    check(
      pages.length === 2 &&
        pages.every(
          (p) =>
            Buffer.byteLength(JSON.stringify(p)) <= LIMITS.observationBodyBytes
        ),
      "publisher splits bounded revision pages"
    );
    for (const page of pages) {
      await client().observe(page);
      sequence = page.sequence + 1;
    }
    await send([a]);
    const first = identity,
      firstSession = sessionId,
      firstSequence = sequence;
    identity = await rpc("enroll", "Second host");
    await open();
    const [otherBinding] = await identities(identity.environmentId, [
      a.localProjectId,
    ]);
    const other = {
      ...a,
      projectId: otherBinding.projectId,
      snapshot: {
        trackerScope: {
          ...scope,
          activeStates: [" In progress ", "Ready", "Ready"],
        },
      },
    };
    await send([other]);
    check(
      other.projectId !== a.projectId,
      "CP01 same local ID has separate global identity"
    );
    check(
      (await rpc("get", a.projectId)).warnings[0]?.state === "identical",
      "CP17 normalized identical scope warning"
    );
    rejected = false;
    try {
      await send([a]);
    } catch (error) {
      rejected = error.code === "invalid_input";
    }
    check(rejected, "foreign environment project cannot overwrite state");
    await rpc("expire");
    check(
      (await rpc("summary")).freshRunning === 0 &&
        !(await rpc("get", a.projectId)).fresh,
      "CP10 skewed clock cannot keep running count fresh"
    );
    await stop();
    await start();
    const cached = await rpc("get", a.projectId);
    check(
      !cached.fresh && cached.observation.process.state === "running",
      "CP05 restart retains stale process observations"
    );
    identity = first;
    sessionId = firstSession;
    sequence = firstSequence;
    rejected = false;
    try {
      await send([a]);
    } catch (error) {
      rejected = error.code === "unauthenticated";
    }
    check(rejected, "restart rejects old session observation");
    await open();
    await send([a]);
    check(
      (await rpc("get", a.projectId)).fresh &&
        (await rpc("get", a.projectId)).warnings[0]?.state === "unverified",
      "current-session recovery leaves offline overlap unverified"
    );
    const all = await identities(
      identity.environmentId,
      Array.from({ length: 30 }, (_, i) => `paged-${i}`)
    );
    const entries = all.map(({ projectId, localProjectId }) => ({
      ...a,
      projectId,
      localProjectId,
    }));
    await send(entries);
    const page = pageSchema(aggregateProjectSchema).parse(await rpc("list"));
    const next = pageSchema(aggregateProjectSchema).parse(
      await rpc("list", { cursor: page.nextCursor })
    );
    check(
      page.items.length === 25 &&
        new Set([...page.items, ...next.items].map((p) => p.projectId)).size ===
          33,
      "operator project paging retains separate historical rows"
    );
    rejected = false;
    try {
      await rpc("list", { cursor: page.nextCursor, process: "stopped" });
    } catch (error) {
      rejected = error.code === "cursor_reset";
    }
    check(rejected, "changed filter resets cursor");
    for (const project of registry.list())
      await registry.remove(project.localProjectId);
    check(
      (await snapshot(registry, new AbortController().signal)).length === 0,
      "CP14 current publisher excludes removed allowlist folder"
    );
    await rpc("revoke", identity.environmentId);
    rejected = false;
    try {
      await rpc("submit", entries[0].projectId, "after-revoke", {
        operation: "start",
      });
    } catch (error) {
      rejected = error.code === "access_revoked";
    }
    check(rejected, "revoked inventory command reports access_revoked");
    identity = await rpc("replace", identity.environmentId);
    await open();
    const [replacementIdentity] = await identities(identity.environmentId, [
      entries[0].localProjectId,
    ]);
    check(
      replacementIdentity.projectId !== entries[0].projectId,
      "replacement enrollment allocates distinct project UUID"
    );
    const replacement = {
      ...entries[0],
      projectId: replacementIdentity.projectId,
    };
    const replacementRevision = randomUUID();
    await send([replacement], replacementRevision, 0, 2);
    const retired = await rpc("get", entries[0].projectId);
    check(
      !retired.managed && !retired.fresh && retired.snapshotStale,
      "replacement partial inventory cannot revive old host target"
    );
    const pending = Array.from({ length: 99 }, (_, i) => `unpublished-${i}`);
    await identities(identity.environmentId, pending);
    rejected = false;
    try {
      await identities(identity.environmentId, ["overflow"]);
    } catch (error) {
      rejected = error.code === "invalid_input";
    }
    check(rejected, "cumulative unpublished identity cap rejects overflow");
    await send([], replacementRevision, 1, 2);
    const released = await identities(identity.environmentId, ["overflow"]);
    check(
      released.length === 1 && (await rpc("get", replacement.projectId)).fresh,
      "complete replacement inventory releases unpublished capacity"
    );
    console.log(
      `C06 PASS: ${reached} reached assertions; actual OS=${process.platform}; no native service or UI acceptance claimed`
    );
  } finally {
    if (registry) await registry.close();
    if (child && child.exitCode === null) {
      const exit = once(child, "exit");
      child.kill();
      await exit;
    }
    rmSync(root, { recursive: true, force: true });
  }
}
