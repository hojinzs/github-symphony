import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  PROTOCOL_VERSION,
  sessionRequestSchema,
  observationRequestSchema,
  uuidSchema,
  type SessionRequest,
  type SessionResponse,
  type ObservationRequest,
  type Acknowledgment,
} from "@gh-symphony/management-protocol";
import {
  FleetError,
  type EnrollmentService,
  type AgentCredential,
  type AgentSessionCredential,
} from "./enrollment.js";
import type { FleetStore } from "./store.js";

export const SESSION_LIFETIME_MS = 30_000;
export interface SessionOptions {
  now?: () => Date;
  /** Synchronous sibling projection writes, in the authentication/sequence transaction. */
  receiveObservation: (
    database: DatabaseSync,
    request: ObservationRequest
  ) => undefined;
}
export interface SessionService {
  openSession(
    identity: AgentCredential,
    request: SessionRequest
  ): Promise<SessionResponse>;
  observe(
    identity: AgentCredential,
    request: ObservationRequest
  ): Promise<Acknowledgment>;
  authenticateSession(identity: AgentSessionCredential): void;
  /** C04 revocation calls this inside its existing transaction. */
  invalidate(database: DatabaseSync, environmentId: string): void;
  expire(): void;
  /** Call once at fleet process startup, before serving agent requests. */
  recoverAfterRestart(): void;
}
interface SessionRow {
  agent_id: string;
  session_id: string;
  expires_at: string;
  sequence: number;
}
export function createSessionService(
  store: FleetStore,
  enrollment: EnrollmentService,
  options: SessionOptions
): SessionService {
  const database = store.database;
  const now = options.now ?? (() => new Date());
  if (typeof options.receiveObservation !== "function")
    throw new Error(
      "Session service requires an observation projection boundary"
    );
  function row(environmentId: string): SessionRow | undefined {
    return database
      .prepare(
        "SELECT agent_id, session_id, expires_at, sequence FROM agent_sessions WHERE environment_id = ?"
      )
      .get(environmentId) as unknown as SessionRow | undefined;
  }
  function verify(identity: AgentSessionCredential): SessionRow {
    uuidSchema.parse(identity.sessionId);
    const current = row(identity.environmentId);
    if (
      !current ||
      current.agent_id !== identity.agentId ||
      current.session_id !== identity.sessionId ||
      !(Date.parse(current.expires_at) > now().getTime())
    )
      throw new FleetError(
        "unauthenticated",
        "Current agent session is required"
      );
    return current;
  }
  function matches(
    identity: AgentCredential,
    environmentId: string,
    agentId?: string
  ) {
    if (
      identity.environmentId !== environmentId ||
      (agentId !== undefined && identity.agentId !== agentId)
    )
      throw new FleetError(
        "unauthenticated",
        "Request identity does not match credential"
      );
  }
  function expire() {
    store.transaction(() => {
      database
        .prepare(
          "UPDATE environments SET connection = 'offline' WHERE enrollment = 'enrolled' AND id IN (SELECT environment_id FROM agent_sessions WHERE expires_at <= ?)"
        )
        .run(now().toISOString());
    });
  }
  return {
    async openSession(identity, input) {
      if (input?.protocolVersion !== PROTOCOL_VERSION)
        throw new FleetError(
          "unsupported_protocol",
          "Unsupported management protocol"
        );
      const request = sessionRequestSchema.parse(input);
      matches(identity, request.environmentId, request.agentId);
      return store.transaction(() => {
        enrollment.authenticate(identity);
        const current = row(request.environmentId);
        if (current && Date.parse(current.expires_at) > now().getTime())
          throw new FleetError(
            "session_conflict",
            "Agent already has a live session"
          );
        const sessionId = randomUUID();
        const expiresAt = new Date(
          now().getTime() + SESSION_LIFETIME_MS
        ).toISOString();
        database
          .prepare(
            "INSERT INTO agent_sessions (environment_id, agent_id, session_id, expires_at, sequence, agent_version, hostname, os) VALUES (?, ?, ?, ?, -1, ?, ?, ?) ON CONFLICT(environment_id) DO UPDATE SET agent_id=excluded.agent_id, session_id=excluded.session_id, expires_at=excluded.expires_at, sequence=-1, agent_version=excluded.agent_version, hostname=excluded.hostname, os=excluded.os"
          )
          .run(
            request.environmentId,
            request.agentId,
            sessionId,
            expiresAt,
            request.agentVersion,
            request.host.hostname,
            request.host.os
          );
        // Negotiation alone is not an authenticated heartbeat.
        database
          .prepare(
            "UPDATE environments SET connection = CASE WHEN last_contact_at IS NULL THEN 'awaiting-signal' ELSE 'offline' END WHERE id = ?"
          )
          .run(request.environmentId);
        return {
          protocolVersion: PROTOCOL_VERSION,
          requestId: request.requestId,
          environmentId: request.environmentId,
          sessionId,
          expiresAt,
        };
      });
    },
    async observe(identity, input) {
      const request = observationRequestSchema.parse(input);
      matches(identity, request.environmentId);
      const sessionIdentity = { ...identity, sessionId: request.sessionId };
      enrollment.recordAuthenticatedSignal(
        sessionIdentity,
        (transactionDatabase) => {
          if (transactionDatabase !== database)
            throw new Error(
              "Session and enrollment must share the same fleet connection"
            );
          const current = verify(sessionIdentity);
          if (request.sequence > current.sequence) {
            const result = options.receiveObservation(database, request);
            if (result !== undefined)
              throw new Error(
                "Observation projection must perform synchronous database work"
              );
            database
              .prepare(
                "UPDATE agent_sessions SET sequence = ? WHERE environment_id = ? AND session_id = ?"
              )
              .run(request.sequence, request.environmentId, request.sessionId);
          }
          database
            .prepare(
              "UPDATE agent_sessions SET expires_at = ? WHERE environment_id = ? AND session_id = ?"
            )
            .run(
              new Date(now().getTime() + SESSION_LIFETIME_MS).toISOString(),
              request.environmentId,
              request.sessionId
            );
          return true;
        }
      );
      return {
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        environmentId: request.environmentId,
        sessionId: request.sessionId,
        receivedAt: now().toISOString(),
      };
    },
    authenticateSession(identity) {
      // Poll/claim/result ownership uses this boundary; polls do not renew heartbeat freshness.
      enrollment.authenticate(identity);
      verify(identity);
    },
    invalidate(targetDatabase, environmentId) {
      targetDatabase
        .prepare("DELETE FROM agent_sessions WHERE environment_id = ?")
        .run(environmentId);
    },
    expire,
    recoverAfterRestart() {
      store.transaction(() => {
        database
          .prepare("UPDATE agent_sessions SET expires_at = ?")
          .run(now().toISOString());
        database.exec(
          "UPDATE environments SET connection = 'offline' WHERE enrollment = 'enrolled'"
        );
      });
    },
  };
}
