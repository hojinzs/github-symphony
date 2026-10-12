import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  LIMITS,
  OPERATOR_ACTOR,
  PROTOCOL_VERSION,
  createEnvironmentRequestSchema,
  enrollmentRequestSchema,
  uuidSchema,
  type AgentControlPlaneClient,
  type EnvironmentRecord,
  type EnrollmentTokenResponse,
  type ErrorCode,
  type OperatorManagementClient,
  type UUID,
} from "@gh-symphony/management-protocol";
import type { FleetStore } from "./store.js";

export class FleetError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string
  ) {
    super(message);
    this.name = "FleetError";
  }
}
export interface AgentCredential {
  environmentId: UUID;
  agentId: UUID;
  credential: string;
}
export interface AgentSessionCredential extends AgentCredential {
  sessionId: UUID;
}
/** Peer-owned session/command writes on the supplied, already-open transaction. */
export type RevocationInvalidator = (
  database: DatabaseSync,
  environmentId: UUID
) => undefined;
/** The session owner must verify exclusive current-session ownership. */
export type SessionVerifier = (
  database: DatabaseSync,
  identity: AgentSessionCredential
) => boolean;
export interface EnrollmentService
  extends
    Pick<
      OperatorManagementClient,
      | "createEnvironment"
      | "listEnvironments"
      | "regenerateEnrollment"
      | "revoke"
    >,
    Pick<AgentControlPlaneClient, "enroll"> {
  authenticate(identity: AgentCredential): void;
  recordAuthenticatedSignal(
    identity: AgentSessionCredential,
    verifySession: SessionVerifier
  ): void;
}
export interface EnrollmentOptions {
  invalidateManagementAccess: RevocationInvalidator;
  now?: () => Date;
}
function verifier(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}
function secret(): string {
  return randomBytes(32).toString("base64url");
}
interface EnvironmentRow {
  id: string;
  name: string;
  enrollment: EnvironmentRecord["enrollment"];
  connection: EnvironmentRecord["connection"];
  last_contact_at: string | null;
}

/** Library methods are a trusted server boundary; browser callers need CSRF first. */
export function createEnrollmentService(
  store: FleetStore,
  options: EnrollmentOptions
): EnrollmentService {
  if (typeof options.invalidateManagementAccess !== "function") {
    throw new Error("Fleet enrollment requires a peer revocation invalidator");
  }
  const database = store.database;
  const now = options.now ?? (() => new Date());
  function environment(id: UUID): EnvironmentRow {
    uuidSchema.parse(id);
    const row = database
      .prepare(
        "SELECT id, name, enrollment, connection, last_contact_at FROM environments WHERE id = ?"
      )
      .get(id);
    if (!row) throw new FleetError("not_found", "Environment does not exist");
    return row as unknown as EnvironmentRow;
  }
  function audit(
    actor: string,
    target: UUID,
    operation: string,
    requestId: UUID | null = null
  ) {
    database
      .prepare(
        "INSERT INTO audit_records (actor, target, operation, request_id, occurred_at, outcome) VALUES (?, ?, ?, ?, ?, 'success')"
      )
      .run(actor, target, operation, requestId, now().toISOString());
  }
  function issueToken(id: UUID): EnrollmentTokenResponse {
    const token = secret();
    const expiresAt = new Date(
      now().getTime() + LIMITS.enrollmentTokenLifetimeMs
    ).toISOString();
    database
      .prepare(
        "INSERT INTO enrollment_tokens (environment_id, verifier, expires_at) VALUES (?, ?, ?) ON CONFLICT(environment_id) DO UPDATE SET verifier = excluded.verifier, expires_at = excluded.expires_at"
      )
      .run(id, verifier(token), expiresAt);
    return { environmentId: id, token, expiresAt };
  }
  function authenticate(identity: AgentCredential): void {
    uuidSchema.parse(identity.environmentId);
    uuidSchema.parse(identity.agentId);
    if (
      typeof identity.credential !== "string" ||
      identity.credential.length > 256 ||
      !identity.credential
    ) {
      throw new FleetError("unauthenticated", "Invalid agent credential");
    }
    const row = database
      .prepare(
        "SELECT c.verifier FROM agent_credentials c JOIN environments e ON e.id = c.environment_id WHERE c.environment_id = ? AND c.agent_id = ? AND e.enrollment = 'enrolled'"
      )
      .get(identity.environmentId, identity.agentId);
    if (
      !row ||
      typeof row.verifier !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.verifier) ||
      !timingSafeEqual(
        Buffer.from(String(row.verifier), "hex"),
        Buffer.from(verifier(identity.credential), "hex")
      )
    ) {
      throw new FleetError("unauthenticated", "Invalid agent credential");
    }
  }
  return {
    async createEnvironment(input) {
      const { name } = createEnvironmentRequestSchema.parse(input);
      if (Buffer.byteLength(name.trim(), "utf8") > 256)
        throw new FleetError(
          "invalid_input",
          "Environment name exceeds 256 bytes"
        );
      return store.transaction(() => {
        const id = randomUUID();
        database
          .prepare(
            "INSERT INTO environments (id, name, enrollment, connection) VALUES (?, ?, 'pending', 'awaiting-signal')"
          )
          .run(id, name.trim());
        const token = issueToken(id);
        audit(OPERATOR_ACTOR, id, "environment.create");
        return token;
      });
    },
    async listEnvironments() {
      return database
        .prepare(
          "SELECT e.id, e.name, e.enrollment, e.connection, e.last_contact_at, s.agent_version, s.hostname, s.os FROM environments e LEFT JOIN agent_sessions s ON s.environment_id = e.id ORDER BY e.rowid"
        )
        .all()
        .map((row) => ({
          environmentId: String(row.id),
          name: String(row.name),
          enrollment: row.enrollment as EnvironmentRecord["enrollment"],
          connection: row.connection as EnvironmentRecord["connection"],
          ...(row.agent_version
            ? {
                agentVersion: String(row.agent_version),
                host: {
                  hostname: String(row.hostname),
                  os: row.os as "linux" | "darwin",
                },
              }
            : {}),
          ...(row.last_contact_at
            ? { lastContactAt: String(row.last_contact_at) }
            : {}),
        }));
    },
    async regenerateEnrollment(id) {
      return store.transaction(() => {
        const record = environment(id);
        if (record.enrollment === "enrolled")
          throw new FleetError(
            "session_conflict",
            "Revoke the enrolled agent before replacement"
          );
        const token = issueToken(id);
        database
          .prepare(
            "UPDATE environments SET enrollment = 'pending', connection = 'awaiting-signal', last_contact_at = NULL WHERE id = ?"
          )
          .run(id);
        audit(OPERATOR_ACTOR, id, "enrollment.regenerate");
        return token;
      });
    },
    async enroll(input) {
      if (input?.protocolVersion !== PROTOCOL_VERSION)
        throw new FleetError(
          "unsupported_protocol",
          "Unsupported management protocol"
        );
      const request = enrollmentRequestSchema.parse(input);
      if (request.token.length > 256)
        throw new FleetError("unauthenticated", "Invalid enrollment token");
      return store.transaction(() => {
        const token = database
          .prepare(
            "SELECT t.environment_id, t.expires_at FROM enrollment_tokens t JOIN environments e ON e.id = t.environment_id WHERE t.verifier = ? AND e.enrollment = 'pending'"
          )
          .get(verifier(request.token));
        const expiresAt = token ? Date.parse(String(token.expires_at)) : NaN;
        if (
          !token ||
          !Number.isFinite(expiresAt) ||
          expiresAt <= now().getTime()
        ) {
          throw new FleetError(
            "unauthenticated",
            "Invalid or expired enrollment token"
          );
        }
        const environmentId = String(token.environment_id);
        const agentId = randomUUID();
        const credential = secret();
        database
          .prepare("DELETE FROM enrollment_tokens WHERE environment_id = ?")
          .run(environmentId);
        database
          .prepare(
            "INSERT INTO agent_credentials (environment_id, agent_id, verifier) VALUES (?, ?, ?)"
          )
          .run(environmentId, agentId, verifier(credential));
        database
          .prepare(
            "UPDATE environments SET enrollment = 'enrolled', connection = 'awaiting-signal', last_contact_at = NULL WHERE id = ?"
          )
          .run(environmentId);
        audit(
          `agent:${agentId}`,
          environmentId,
          "agent.enroll",
          request.requestId
        );
        return {
          protocolVersion: PROTOCOL_VERSION,
          requestId: request.requestId,
          environmentId,
          agentId,
          credential,
        };
      });
    },
    async revoke(id) {
      store.transaction(() => {
        const record = environment(id);
        if (record.enrollment === "revoked") return;
        database
          .prepare("DELETE FROM enrollment_tokens WHERE environment_id = ?")
          .run(id);
        database
          .prepare("DELETE FROM agent_credentials WHERE environment_id = ?")
          .run(id);
        database
          .prepare(
            "UPDATE environments SET enrollment = 'revoked', connection = 'offline' WHERE id = ?"
          )
          .run(id);
        const invalidation = options.invalidateManagementAccess(database, id);
        if (invalidation !== undefined)
          throw new Error(
            "Revocation invalidator must perform synchronous database work"
          );
        audit(OPERATOR_ACTOR, id, "environment.revoke");
      });
    },
    authenticate,
    recordAuthenticatedSignal(identity, verifySession) {
      uuidSchema.parse(identity.sessionId);
      store.transaction(() => {
        authenticate(identity);
        if (verifySession(database, identity) !== true)
          throw new FleetError(
            "unauthenticated",
            "Current agent session is required"
          );
        database
          .prepare(
            "UPDATE environments SET connection = 'online', last_contact_at = ? WHERE id = ?"
          )
          .run(now().toISOString(), identity.environmentId);
      });
    },
  };
}
