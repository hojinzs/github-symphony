import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import {
  enrollmentResponseSchema,
  enrollmentTokenResponseSchema,
  environmentRecordSchema,
  type EnrollmentRequest,
  type EnrollmentResponse,
} from "@gh-symphony/management-protocol";
import { openFleetStore, type FleetStore } from "./store.js";
import {
  createEnrollmentService,
  type EnrollmentService,
  type RevocationInvalidator,
} from "./enrollment.js";
import { attachPeerStore } from "../test-fixtures/peer-store.js";

const dirs: string[] = [];
const stores: FleetStore[] = [];
const workers: Worker[] = [];
function directory() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-enrollment-")));
  dirs.push(dir);
  return dir;
}
function fixture(dir = directory()) {
  const store = openFleetStore(dir);
  stores.push(store);
  const peer = attachPeerStore(store.database);
  let time = Date.parse("2026-10-06T00:00:00Z");
  const service = createEnrollmentService(store, {
    invalidateManagementAccess: peer.invalidate,
    now: () => new Date(time),
  });
  return {
    dir,
    store,
    service,
    peer,
    advance: (ms: number) => {
      time += ms;
    },
  };
}
function request(token: string): EnrollmentRequest {
  return { protocolVersion: 1, requestId: randomUUID(), token };
}
async function enroll(service: EnrollmentService) {
  const token = await service.createEnvironment({ name: "Linux host" });
  return { token, identity: await service.enroll(request(token.token)) };
}
function session(f: ReturnType<typeof fixture>, identity: EnrollmentResponse) {
  const sessionId = randomUUID();
  f.store.database
    .prepare(
      "INSERT INTO fixture_sessions (environment_id, agent_id, session_id) VALUES (?, ?, ?)"
    )
    .run(identity.environmentId, identity.agentId, sessionId);
  return { ...identity, sessionId };
}
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.terminate();
  for (const store of stores.splice(0)) {
    try {
      store.close();
    } catch {
      /* already closed for restart tests */
    }
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("C04 enrollment persistence and C01 peer contracts", () => {
  it("audits absent operator request IDs as null and preserves the enrollment request ID", async () => {
    const f = fixture();
    const first = await f.service.createEnvironment({ name: "Host" });
    const replacement = await f.service.regenerateEnrollment(
      first.environmentId
    );
    const exchange = request(replacement.token);
    await f.service.enroll(exchange);
    await f.service.revoke(first.environmentId);
    expect(
      f.store.database
        .prepare("SELECT operation, request_id FROM audit_records ORDER BY id")
        .all()
    ).toEqual([
      { operation: "environment.create", request_id: null },
      { operation: "enrollment.regenerate", request_id: null },
      { operation: "agent.enroll", request_id: exchange.requestId },
      { operation: "environment.revoke", request_id: null },
    ]);
  });
  it("persists pending records across restart without recovering raw tokens", async () => {
    const f = fixture();
    const token = await f.service.createEnvironment({ name: "  Mac host  " });
    expect(enrollmentTokenResponseSchema.parse(token)).toEqual(token);
    expect(token.expiresAt).toBe("2026-10-06T00:10:00.000Z");
    f.store.close();
    const reopened = fixture(f.dir);
    expect(await reopened.service.listEnvironments()).toEqual([
      {
        environmentId: token.environmentId,
        name: "Mac host",
        enrollment: "pending",
        connection: "awaiting-signal",
      },
    ]);
    expect(
      readFileSync(join(f.dir, "fleet.sqlite")).includes(
        Buffer.from(token.token)
      )
    ).toBe(false);
    const saved = reopened.store.database
      .prepare("SELECT verifier FROM enrollment_tokens")
      .get()!;
    expect(saved.verifier).not.toBe(token.token);
    expect(
      reopened.store.database
        .prepare("SELECT actor, target, operation, outcome FROM audit_records")
        .all()
    ).toEqual([
      {
        actor: "local-owner",
        target: token.environmentId,
        operation: "environment.create",
        outcome: "success",
      },
    ]);
  });

  it("expires tokens at the deadline and regeneration fences every earlier token", async () => {
    const f = fixture();
    const first = await f.service.createEnvironment({ name: "Host" });
    f.advance(600_000);
    await expect(f.service.enroll(request(first.token))).rejects.toMatchObject({
      code: "unauthenticated",
    });
    const second = await f.service.regenerateEnrollment(first.environmentId);
    const third = await f.service.regenerateEnrollment(first.environmentId);
    expect(third.environmentId).toBe(first.environmentId);
    expect(third.token).not.toBe(second.token);
    expect(
      f.store.database
        .prepare(
          "SELECT actor, outcome FROM audit_records WHERE operation = 'enrollment.regenerate'"
        )
        .all()
    ).toEqual([
      { actor: "local-owner", outcome: "success" },
      { actor: "local-owner", outcome: "success" },
    ]);
    await expect(f.service.enroll(request(second.token))).rejects.toMatchObject(
      { code: "unauthenticated" }
    );
    f.store.database
      .prepare(
        "UPDATE enrollment_tokens SET expires_at = 'invalid-date' WHERE environment_id = ?"
      )
      .run(third.environmentId);
    await expect(f.service.enroll(request(third.token))).rejects.toMatchObject({
      code: "unauthenticated",
    });
    f.store.database
      .prepare(
        "UPDATE enrollment_tokens SET expires_at = ? WHERE environment_id = ?"
      )
      .run(third.expiresAt, third.environmentId);
    const exchange = f.service.enroll(request(third.token));
    await expect(exchange).resolves.toMatchObject({
      environmentId: first.environmentId,
    });
    const identity = await exchange;
    expect(enrollmentResponseSchema.parse(identity)).toEqual(identity);
    expect(
      environmentRecordSchema.parse((await f.service.listEnvironments())[0])
    ).toMatchObject({ enrollment: "enrolled", connection: "awaiting-signal" });
    expect(
      readFileSync(join(f.dir, "fleet.sqlite")).includes(
        Buffer.from(identity.credential)
      )
    ).toBe(false);
  });

  it("rejects reuse even with the original request ID and audits exchange once", async () => {
    const f = fixture();
    const token = await f.service.createEnvironment({ name: "Host" });
    const exchange = request(token.token);
    const identity = await f.service.enroll(exchange);
    await expect(f.service.enroll(exchange)).rejects.toMatchObject({
      code: "unauthenticated",
    });
    expect(
      f.store.database
        .prepare("SELECT environment_id FROM enrollment_tokens")
        .all()
    ).toEqual([]);
    expect(
      f.store.database
        .prepare(
          "SELECT actor, target, request_id, outcome FROM audit_records WHERE operation = 'agent.enroll'"
        )
        .all()
    ).toEqual([
      {
        actor: `agent:${identity.agentId}`,
        target: identity.environmentId,
        request_id: exchange.requestId,
        outcome: "success",
      },
    ]);
  });

  it("authenticates environment and agent identity and requires a current session for first signal", async () => {
    const f = fixture();
    const first = await enroll(f.service);
    const second = await enroll(f.service);
    expect(() => f.service.authenticate(first.identity)).not.toThrow();
    for (const identity of [
      { ...first.identity, environmentId: second.identity.environmentId },
      { ...first.identity, agentId: second.identity.agentId },
      { ...first.identity, credential: second.identity.credential },
    ])
      expect(() => f.service.authenticate(identity)).toThrow();
    const savedVerifier = f.store.database
      .prepare(
        "SELECT verifier FROM agent_credentials WHERE environment_id = ?"
      )
      .get(first.identity.environmentId)!.verifier;
    f.store.database
      .prepare(
        "UPDATE agent_credentials SET verifier = 'corrupt' WHERE environment_id = ?"
      )
      .run(first.identity.environmentId);
    expect(() => f.service.authenticate(first.identity)).toThrowError(
      expect.objectContaining({ code: "unauthenticated" })
    );
    f.store.database
      .prepare(
        "UPDATE agent_credentials SET verifier = ? WHERE environment_id = ?"
      )
      .run(savedVerifier, first.identity.environmentId);
    const live = session(f, first.identity);
    expect(() =>
      f.service.recordAuthenticatedSignal(
        { ...live, sessionId: randomUUID() },
        f.peer.verifySession
      )
    ).toThrow();
    f.service.recordAuthenticatedSignal(live, f.peer.verifySession);
    const records = await f.service.listEnvironments();
    expect(
      records.find((r) => r.environmentId === first.identity.environmentId)
    ).toMatchObject({
      connection: "online",
      lastContactAt: "2026-10-06T00:00:00.000Z",
    });
    expect(
      records.find((r) => r.environmentId === second.identity.environmentId)
    ).toMatchObject({ connection: "awaiting-signal" });
  });

  it("revokes credentials and peer sessions and expires only unclaimed commands", async () => {
    const f = fixture();
    const { identity } = await enroll(f.service);
    const live = session(f, identity);
    f.service.recordAuthenticatedSignal(live, f.peer.verifySession);
    for (const state of ["accepted", "executing"])
      f.store.database
        .prepare(
          "INSERT INTO fixture_commands (environment_id, id, state) VALUES (?, ?, ?)"
        )
        .run(identity.environmentId, state, state);
    await f.service.revoke(identity.environmentId);
    expect(() => f.service.authenticate(identity)).toThrow();
    expect(() =>
      f.service.recordAuthenticatedSignal(live, f.peer.verifySession)
    ).toThrow();
    expect(
      f.store.database
        .prepare("SELECT id, state FROM fixture_commands ORDER BY id")
        .all()
    ).toEqual([
      { id: "accepted", state: "expired" },
      { id: "executing", state: "executing" },
    ]);
    expect(f.peer.verifySession(f.store.database, live)).toBe(false);
    expect(
      f.store.database.prepare("SELECT agent_id FROM agent_credentials").all()
    ).toEqual([]);
    expect(await f.service.listEnvironments()).toEqual([
      {
        environmentId: identity.environmentId,
        name: "Linux host",
        enrollment: "revoked",
        connection: "offline",
        lastContactAt: "2026-10-06T00:00:00.000Z",
      },
    ]);
    await f.service.revoke(identity.environmentId);
    expect(
      f.store.database
        .prepare(
          "SELECT actor, outcome FROM audit_records WHERE operation = 'environment.revoke'"
        )
        .all()
    ).toEqual([{ actor: "local-owner", outcome: "success" }]);
  });

  it("rolls back peer invalidation failure together with credential, token and audit state", async () => {
    const f = fixture();
    const { identity } = await enroll(f.service);
    const live = session(f, identity);
    f.store.database
      .prepare(
        "INSERT INTO fixture_commands (environment_id, id, state) VALUES (?, ?, ?)"
      )
      .run(identity.environmentId, "waiting", "accepted");
    const broken = createEnrollmentService(f.store, {
      invalidateManagementAccess(database, id) {
        f.peer.invalidate(database, id);
        throw new Error("peer write failed");
      },
    });
    await expect(broken.revoke(identity.environmentId)).rejects.toThrow(
      "peer write failed"
    );
    expect(() => f.service.authenticate(identity)).not.toThrow();
    expect(f.peer.verifySession(f.store.database, live)).toBe(true);
    expect(
      f.store.database.prepare("SELECT state FROM fixture_commands").get()
    ).toEqual({ state: "accepted" });
    expect(
      f.store.database
        .prepare(
          "SELECT id FROM audit_records WHERE operation = 'environment.revoke'"
        )
        .get()
    ).toBeUndefined();
    expect((await f.service.listEnvironments())[0].enrollment).toBe("enrolled");
  });

  it("rejects missing or asynchronous peer invalidators and rolls back their writes", async () => {
    const f = fixture();
    const { identity } = await enroll(f.service);
    const live = session(f, identity);
    expect(() =>
      createEnrollmentService(f.store, {
        invalidateManagementAccess:
          undefined as unknown as RevocationInvalidator,
      })
    ).toThrow(/invalidator/);
    const invalidator = ((database: FleetStore["database"], id: string) => {
      f.peer.invalidate(database, id);
      return Promise.resolve();
    }) as unknown as RevocationInvalidator;
    const broken = createEnrollmentService(f.store, {
      invalidateManagementAccess: invalidator,
    });
    await expect(broken.revoke(identity.environmentId)).rejects.toThrow(
      /synchronous/
    );
    expect(() => f.service.authenticate(identity)).not.toThrow();
    expect(f.peer.verifySession(f.store.database, live)).toBe(true);
  });

  it("requires explicit revocation before replacement and fences the previous agent", async () => {
    const f = fixture();
    const { token, identity } = await enroll(f.service);
    const live = session(f, identity);
    f.service.recordAuthenticatedSignal(live, f.peer.verifySession);
    await expect(
      f.service.regenerateEnrollment(token.environmentId)
    ).rejects.toMatchObject({ code: "session_conflict" });
    await f.service.revoke(token.environmentId);
    const replacement = await f.service.regenerateEnrollment(
      token.environmentId
    );
    const next = await f.service.enroll(request(replacement.token));
    expect(next.agentId).not.toBe(identity.agentId);
    expect(next.environmentId).toBe(identity.environmentId);
    expect(() => f.service.authenticate(identity)).toThrow();
    expect((await f.service.listEnvironments())[0]).toEqual({
      environmentId: identity.environmentId,
      name: "Linux host",
      enrollment: "enrolled",
      connection: "awaiting-signal",
    });
  });

  it("revokes a pending token and rejects malformed requests without secret diagnostics", async () => {
    const f = fixture();
    const token = await f.service.createEnvironment({ name: "Host" });
    await f.service.revoke(token.environmentId);
    expect(
      f.store.database
        .prepare("SELECT environment_id FROM enrollment_tokens")
        .all()
    ).toEqual([]);
    await expect(f.service.enroll(request(token.token))).rejects.toMatchObject({
      code: "unauthenticated",
    });
    for (const bad of [
      { ...request(token.token), protocolVersion: 2 },
      { ...request(token.token), requestId: "bad-id" },
      { ...request(token.token), token: "" },
    ]) {
      try {
        await f.service.enroll(bad as EnrollmentRequest);
        expect.fail("invalid input accepted");
      } catch (error) {
        expect(error).toMatchObject({
          code: expect.stringMatching(/invalid_input|unsupported_protocol/),
        });
        expect(String(error)).not.toContain(token.token);
      }
    }
    for (const name of ["x".repeat(257), "界".repeat(86)]) {
      await expect(f.service.createEnvironment({ name })).rejects.toMatchObject(
        { code: "invalid_input" }
      );
    }
    await expect(
      f.service.createEnvironment({ name: " " })
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(f.service.revoke(randomUUID())).rejects.toMatchObject({
      code: "not_found",
    });
    expect(await f.service.listEnvironments()).toHaveLength(1);
  });

  it("rolls back exchange when audit persistence fails and permits recovery with the original token", async () => {
    const f = fixture();
    const token = await f.service.createEnvironment({ name: "Host" });
    f.store.database.exec(
      "CREATE TRIGGER fixture_audit_fault BEFORE INSERT ON audit_records WHEN NEW.operation = 'agent.enroll' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;"
    );
    await expect(f.service.enroll(request(token.token))).rejects.toThrow(
      "audit unavailable"
    );
    expect(
      f.store.database.prepare("SELECT agent_id FROM agent_credentials").get()
    ).toBeUndefined();
    expect((await f.service.listEnvironments())[0].enrollment).toBe("pending");
    f.store.database.exec("DROP TRIGGER fixture_audit_fault");
    expect(await f.service.enroll(request(token.token))).toHaveProperty(
      "credential"
    );
  });

  it("allows exactly one exchange across simultaneous independent SQLite connections on worker threads", async () => {
    const f = fixture();
    const token = await f.service.createEnvironment({ name: "Host" });
    const compiled = join(directory(), "compiled");
    mkdirSync(compiled);
    // Compile actual sources into a temporary ESM package, including C01. No mock implementation.
    const src = dirname(fileURLToPath(import.meta.url));
    const protocolSrc = join(src, "../../management-protocol/src");
    const protocolDest = join(
      compiled,
      "node_modules/@gh-symphony/management-protocol"
    );
    mkdirSync(protocolDest, { recursive: true });
    writeFileSync(join(compiled, "package.json"), '{"type":"module"}');
    writeFileSync(
      join(protocolDest, "package.json"),
      '{"type":"module","exports":"./index.js"}'
    );
    for (const [source, destination, files] of [
      [src, compiled, ["enrollment", "store", "migrations", "persistence"]],
      [
        protocolSrc,
        protocolDest,
        ["index", "constants", "contracts", "schemas", "validation"],
      ],
    ] as const) {
      for (const file of files)
        writeFileSync(
          join(destination, file + ".js"),
          transpileModule(readFileSync(join(source, file + ".ts"), "utf8"), {
            compilerOptions: {
              module: ModuleKind.ESNext,
              target: ScriptTarget.ES2022,
            },
          }).outputText
        );
    }
    const barrier = new SharedArrayBuffer(4);
    const entry = pathToFileURL(join(compiled, "enrollment.js")).href;
    const storeEntry = pathToFileURL(join(compiled, "store.js")).href;
    const ready: Promise<void>[] = [];
    const results: Promise<{ ok: boolean; code?: string }>[] = [];
    const exchange = request(token.token);
    for (let n = 0; n < 2; n++) {
      const worker = new Worker(
        `
        const { parentPort, workerData } = require("node:worker_threads");
        (async () => {
          const { openFleetStore } = await import(workerData.storeEntry);
          const { createEnrollmentService } = await import(workerData.entry);
          const store = openFleetStore(workerData.dir);
          const service = createEnrollmentService(store, { invalidateManagementAccess: () => undefined, now: () => new Date("2026-10-06T00:00:00Z") });
          parentPort.postMessage("ready");
          Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
          try { await service.enroll(workerData.exchange); parentPort.postMessage({ ok: true }); }
          catch (error) { parentPort.postMessage({ ok: false, code: error.code }); }
          finally { store.close(); }
        })().catch(error => { throw error; });
      `,
        {
          eval: true,
          workerData: { entry, storeEntry, dir: f.dir, exchange, barrier },
        }
      );
      workers.push(worker);
      ready.push(
        new Promise((resolve, reject) => {
          worker.on("message", (message) => {
            if (message === "ready") resolve();
          });
          worker.on("error", reject);
        })
      );
      results.push(
        new Promise((resolve, reject) => {
          worker.on("message", (message) => {
            if (message !== "ready") resolve(message);
          });
          worker.on("error", reject);
        })
      );
    }
    await Promise.all(ready);
    Atomics.store(new Int32Array(barrier), 0, 1);
    Atomics.notify(new Int32Array(barrier), 0);
    const outcomes = await Promise.all(results);
    expect(outcomes.filter((result) => result.ok)).toHaveLength(1);
    expect(outcomes.find((result) => !result.ok)).toEqual({
      ok: false,
      code: "unauthenticated",
    });
    expect(
      f.store.database.prepare("SELECT agent_id FROM agent_credentials").all()
    ).toHaveLength(1);
  }, 15_000);
});
