import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  CommandRecord,
  ClaimRequest,
  ClaimResponse,
  ResultRequest,
  Acknowledgment,
  OperatorManagementClient,
  UUID,
} from "@gh-symphony/management-protocol";
import {
  LIMITS,
  OPERATOR_ACTOR,
  PROTOCOL_VERSION,
  uuidSchema,
  submitCommandRequestSchema,
  closeUnresolvedRequestSchema,
  pageRequestSchema,
  claimRequestSchema,
  resultRequestSchema,
  commandRecordSchema,
  type Schema,
  type JsonValue,
} from "@gh-symphony/management-protocol";
import { FleetError } from "./enrollment.js";
import type { FleetStore } from "./store.js";
import type { AgentSessionCredential } from "./enrollment.js";

export interface CommandTarget {
  projectId: UUID;
  environmentId: UUID;
  localProjectId: string;
  agentId: UUID;
  sessionId: UUID;
  managed: boolean;
  online: boolean;
  valid: boolean;
  supported: boolean;
}
export interface CommandPeers {
  /** Synchronous peer-owned reads on the supplied transaction connection. */
  resolveTarget(
    database: DatabaseSync,
    projectId: UUID
  ): CommandTarget | undefined;
  /** Must authenticate enrollment credential AND exclusive current session. */
  verifyAgent(
    database: DatabaseSync,
    identity: AgentSessionCredential
  ): boolean;
}
export interface CommandOptions {
  peers: CommandPeers;
  now?: () => Date;
}
export interface CommandService extends Pick<
  OperatorManagementClient,
  "submitCommand" | "getCommand" | "listCommands" | "closeUnresolved"
> {
  claim(
    identity: AgentSessionCredential,
    request: ClaimRequest
  ): Promise<ClaimResponse>;
  publishResult(
    identity: AgentSessionCredential,
    request: ResultRequest
  ): Promise<Acknowledgment>;
  recover(): void;
  transferOwnership(
    identity: AgentSessionCredential,
    commandId: UUID
  ): CommandRecord;
  /** Call inside the peer's revocation transaction; no nested transaction. */
  invalidateEnvironment(database: DatabaseSync, environmentId: UUID): undefined;
  invalidateProject(projectId: UUID): void;
  prune(): { commands: number; audits: number };
}

function parse<T>(schema: Schema<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch {
    throw new FleetError("invalid_input", "Invalid command input");
  }
}
function json(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(json).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${json(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Trusted library boundary. HTTP consumers must resolve local-owner/CSRF first. */
export function createCommandService(
  store: FleetStore,
  options: CommandOptions
): CommandService {
  const db = store.database;
  const now = options.now ?? (() => new Date());
  if (!options.peers?.resolveTarget || !options.peers.verifyAgent)
    throw new Error(
      "Command service requires project and authenticated session peers"
    );

  function record(row: Record<string, unknown>): CommandRecord {
    return commandRecordSchema.parse({
      commandId: row.command_id,
      projectId: row.project_id,
      environmentId: row.environment_id,
      localProjectId: row.local_project_id,
      sessionId: row.session_id,
      operation: row.operation,
      actor: row.actor,
      idempotencyKey: row.idempotency_key,
      submittedAt: row.submitted_at,
      expiresAt: row.expires_at,
      state: row.state,
      ...(row.claimed_at
        ? {
            claimedAt: row.claimed_at,
            owner: {
              agentId: row.owner_agent_id,
              sessionId: row.owner_session_id,
            },
          }
        : {}),
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      ...(row.evidence !== null
        ? { evidence: JSON.parse(String(row.evidence)) }
        : {}),
      ...(row.diagnostic !== null
        ? { diagnostic: JSON.parse(String(row.diagnostic)) }
        : {}),
      ...(row.closed_at
        ? {
            closure: {
              closedAt: row.closed_at,
              actor: row.closed_actor,
              reason: row.closed_reason,
            },
          }
        : {}),
    });
  }
  function get(id: UUID): CommandRecord {
    parse(uuidSchema, id);
    const row = db
      .prepare("SELECT * FROM lifecycle_commands WHERE command_id=?")
      .get(id);
    if (!row) throw new FleetError("not_found", "Command does not exist");
    return record(row);
  }
  function audit(
    command: CommandRecord,
    operation: string,
    actor: string,
    requestId: string | null = null
  ) {
    db.prepare(
      "INSERT INTO audit_records(actor,target,operation,request_id,occurred_at,outcome) VALUES (?,?,?,?,?,?)"
    ).run(
      actor,
      command.commandId,
      operation,
      requestId,
      now().toISOString(),
      command.state
    );
  }
  function save(command: CommandRecord) {
    // Validate the whole persisted/wire shape before committing any mutation.
    commandRecordSchema.parse(command);
    db.prepare(
      `UPDATE lifecycle_commands SET state=?,claimed_at=?,owner_agent_id=?,owner_session_id=?,
      completed_at=?,evidence=?,diagnostic=?,closed_at=?,closed_actor=?,closed_reason=? WHERE command_id=?`
    ).run(
      command.state,
      command.claimedAt ?? null,
      command.owner?.agentId ?? null,
      command.owner?.sessionId ?? null,
      command.completedAt ?? null,
      command.evidence !== undefined ? json(command.evidence) : null,
      command.diagnostic ? JSON.stringify(command.diagnostic) : null,
      command.closure?.closedAt ?? null,
      command.closure?.actor ?? null,
      command.closure?.reason ?? null,
      command.commandId
    );
  }
  function expire(command: CommandRecord): CommandRecord {
    const current = now().getTime();
    if (
      command.state === "accepted" &&
      Date.parse(command.expiresAt) <= current
    ) {
      command = { ...command, state: "expired" };
      save(command);
      audit(command, "command.expire", "control-plane");
    } else if (
      command.state === "executing" &&
      Date.parse(command.claimedAt!) + LIMITS.executionObservationTimeoutMs <=
        current
    ) {
      command = {
        ...command,
        state: "unknown",
        diagnostic: {
          code: "unresolved_command",
          message: "Execution result not observed before timeout",
        },
      };
      save(command);
      audit(command, "command.unknown", "control-plane");
    }
    return command;
  }
  function recover() {
    for (const row of db
      .prepare(
        "SELECT * FROM lifecycle_commands WHERE state IN ('accepted','executing')"
      )
      .all())
      expire(record(row));
  }
  function verify(identity: AgentSessionCredential) {
    parse(uuidSchema, identity.environmentId);
    parse(uuidSchema, identity.agentId);
    parse(uuidSchema, identity.sessionId);
    if (options.peers.verifyAgent(db, identity) !== true)
      throw new FleetError(
        "claim_owner_conflict",
        "Current authenticated owning session required"
      );
  }
  function envelope(
    identity: AgentSessionCredential,
    request: ClaimRequest | ResultRequest
  ) {
    if (
      request.environmentId !== identity.environmentId ||
      request.sessionId !== identity.sessionId
    )
      throw new FleetError(
        "claim_owner_conflict",
        "Request does not match authenticated identity"
      );
    verify(identity);
  }
  function owner(command: CommandRecord, identity: AgentSessionCredential) {
    if (
      command.environmentId !== identity.environmentId ||
      command.owner?.agentId !== identity.agentId ||
      command.owner.sessionId !== identity.sessionId
    )
      throw new FleetError(
        "claim_owner_conflict",
        "Command belongs to another agent/session"
      );
  }
  function invalidate(database: DatabaseSync, rows: Record<string, unknown>[]) {
    if (database !== db || !database.isTransaction)
      throw new Error("Invalidation requires the shared active transaction");
    for (const row of rows) {
      const command = { ...record(row), state: "expired" as const };
      save(command);
      audit(command, "command.invalidate", "control-plane");
    }
    return undefined;
  }
  return {
    async submitCommand(projectId, key, input) {
      parse(uuidSchema, projectId);
      const request = parse(submitCommandRequestSchema, input);
      if (
        typeof key !== "string" ||
        !key.trim() ||
        Buffer.byteLength(key, "utf8") > 256
      )
        throw new FleetError(
          "invalid_input",
          "Idempotency key must contain 1–256 bytes"
        );
      return store.transaction(() => {
        const previous = db
          .prepare(
            "SELECT * FROM lifecycle_commands WHERE actor=? AND idempotency_key=?"
          )
          .get(OPERATOR_ACTOR, key);
        if (previous) {
          const command = record(previous);
          if (
            command.projectId !== projectId ||
            command.operation !== request.operation
          )
            throw new FleetError(
              "idempotency_conflict",
              "Key already identifies another operation/target"
            );
          // This response is the original acceptance receipt, even after completion.
          return { commandId: command.commandId, state: "accepted" as const };
        }
        recover();
        const target = options.peers.resolveTarget(db, projectId);
        if (!target)
          throw new FleetError("not_found", "Project does not exist");
        if (target.projectId !== projectId)
          throw new Error("Peer returned a different project identity");
        parse(uuidSchema, target.environmentId);
        parse(uuidSchema, target.agentId);
        parse(uuidSchema, target.sessionId);
        if (!target.managed)
          throw new FleetError("project_unmanaged", "Project is not managed");
        if (!target.supported)
          throw new FleetError(
            "unsupported_protocol",
            "Target protocol is unsupported"
          );
        if (!target.valid)
          throw new FleetError(
            "project_invalid",
            "Project configuration is invalid"
          );
        if (!target.online)
          throw new FleetError("agent_offline", "Target is offline");
        const env = db
          .prepare("SELECT enrollment FROM environments WHERE id=?")
          .get(target.environmentId);
        const agent = db
          .prepare(
            "SELECT agent_id FROM agent_credentials WHERE environment_id=?"
          )
          .get(target.environmentId);
        if (
          env?.enrollment !== "enrolled" ||
          agent?.agent_id !== target.agentId
        )
          throw new FleetError(
            "access_revoked",
            "Target enrollment is not active"
          );
        const active = db
          .prepare(
            "SELECT state FROM lifecycle_commands WHERE project_id=? AND (state IN ('accepted','executing') OR (state='unknown' AND closed_at IS NULL))"
          )
          .get(projectId);
        if (active)
          throw new FleetError(
            active.state === "unknown"
              ? "unresolved_command"
              : "command_conflict",
            "Project has an outstanding command"
          );
        const count = db
          .prepare(
            "SELECT count(*) AS n FROM lifecycle_commands WHERE environment_id=? AND (state IN ('accepted','executing') OR (state='unknown' AND closed_at IS NULL))"
          )
          .get(target.environmentId)!;
        if (Number(count.n) >= LIMITS.activeCommandsPerAgent)
          throw new FleetError("agent_busy", "Agent command capacity reached");
        const submittedAt = now().toISOString();
        const command: CommandRecord = {
          commandId: randomUUID(),
          projectId,
          environmentId: target.environmentId,
          localProjectId: target.localProjectId,
          sessionId: target.sessionId,
          operation: request.operation,
          actor: OPERATOR_ACTOR,
          idempotencyKey: key,
          submittedAt,
          expiresAt: new Date(
            Date.parse(submittedAt) + LIMITS.commandClaimLifetimeMs
          ).toISOString(),
          state: "accepted",
        };
        commandRecordSchema.parse(command);
        db.prepare(
          `INSERT INTO lifecycle_commands(command_id,project_id,environment_id,local_project_id,session_id,operation,actor,idempotency_key,submitted_at,expires_at,state)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`
        ).run(
          command.commandId,
          projectId,
          command.environmentId,
          command.localProjectId,
          command.sessionId,
          command.operation,
          command.actor,
          key,
          command.submittedAt,
          command.expiresAt,
          command.state
        );
        audit(command, "command.submit", OPERATOR_ACTOR);
        return { commandId: command.commandId, state: "accepted" as const };
      });
    },
    async getCommand(id) {
      return store.transaction(() => expire(get(id)));
    },
    async listCommands(projectId, input) {
      parse(uuidSchema, projectId);
      const request = parse(pageRequestSchema, input);
      return store.transaction(() => {
        recover();
        let cursor = Number.MAX_SAFE_INTEGER;
        if (request.cursor) {
          parse(uuidSchema, request.cursor);
          const row = db
            .prepare(
              "SELECT rowid AS ordinal FROM lifecycle_commands WHERE command_id=? AND project_id=?"
            )
            .get(request.cursor, projectId);
          if (!row)
            throw new FleetError(
              "invalid_input",
              "Cursor does not belong to project history"
            );
          cursor = Number(row.ordinal);
        }
        const rows = db
          .prepare(
            "SELECT * FROM lifecycle_commands WHERE project_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?"
          )
          .all(projectId, cursor, request.limit + 1);
        const items = rows.slice(0, request.limit).map(record);
        return {
          items,
          ...(rows.length > request.limit
            ? { nextCursor: items.at(-1)!.commandId }
            : {}),
        };
      });
    },
    async closeUnresolved(id, input) {
      const request = parse(closeUnresolvedRequestSchema, input);
      const reason = request.reason.trim();
      if (!reason || Buffer.byteLength(reason, "utf8") > 2048)
        throw new FleetError(
          "invalid_input",
          "Closure requires a bounded nonempty reason"
        );
      return store.transaction(() => {
        const command = expire(get(id));
        if (command.state !== "unknown")
          throw new FleetError(
            "command_conflict",
            "Only unknown commands can be closed unresolved"
          );
        if (command.closure) {
          if (command.closure.reason !== reason)
            throw new FleetError(
              "command_conflict",
              "Unknown already closed with another reason"
            );
          return command;
        }
        command.closure = {
          actor: OPERATOR_ACTOR,
          closedAt: now().toISOString(),
          reason,
        };
        save(command);
        audit(command, "command.close-unresolved", OPERATOR_ACTOR);
        return command;
      });
    },
    async claim(identity, input) {
      const request = parse(claimRequestSchema, input);
      const command = store.transaction(() => {
        envelope(identity, request);
        let command = get(request.commandId);
        if (command.environmentId !== identity.environmentId)
          throw new FleetError(
            "claim_owner_conflict",
            "Command is outside environment scope"
          );
        if (command.owner) {
          owner(command, identity);
          return expire(command);
        }
        if (command.sessionId !== identity.sessionId)
          throw new FleetError(
            "claim_owner_conflict",
            "Command targets another session"
          );
        command = expire(command);
        if (command.state === "expired") return command; // Commit expiry before reporting conflict.
        const target = options.peers.resolveTarget(db, command.projectId);
        if (
          !target?.managed ||
          target.environmentId !== command.environmentId ||
          target.localProjectId !== command.localProjectId
        )
          throw new FleetError(
            "project_unmanaged",
            "Command target is no longer managed"
          );
        command = {
          ...command,
          state: "executing",
          claimedAt: now().toISOString(),
          owner: { agentId: identity.agentId, sessionId: identity.sessionId },
        };
        save(command);
        audit(
          command,
          "command.claim",
          `agent:${identity.agentId}`,
          request.requestId
        );
        return command;
      });
      if (command.state === "expired")
        throw new FleetError(
          "command_expired",
          "Command claim deadline elapsed"
        );
      return {
        protocolVersion: PROTOCOL_VERSION,
        environmentId: request.environmentId,
        sessionId: request.sessionId,
        requestId: request.requestId,
        command,
      };
    },
    async publishResult(identity, input) {
      const request = parse(resultRequestSchema, input);
      if (request.result.kind !== "command")
        throw new FleetError(
          "invalid_input",
          "Read results belong to the read service"
        );
      const result = request.result;
      return store.transaction(() => {
        envelope(identity, request);
        const command = get(result.commandId);
        owner(command, identity);
        if (command.closure)
          throw new FleetError(
            "command_conflict",
            "Explicitly closed outcome cannot be rewritten"
          );
        const observed = Date.parse(result.observedAt);
        if (
          observed < Date.parse(command.claimedAt!) ||
          observed > now().getTime()
        )
          throw new FleetError(
            "invalid_input",
            "Result observation is outside execution lifetime"
          );
        const same =
          command.state === result.state &&
          command.evidence !== undefined &&
          json(command.evidence) === json(result.evidence) &&
          JSON.stringify(command.diagnostic ?? null) ===
            JSON.stringify(result.diagnostic ?? null) &&
          (command.completedAt === undefined ||
            command.completedAt === new Date(observed).toISOString());
        if (command.state === "succeeded" || command.state === "failed") {
          if (!same)
            throw new FleetError(
              "command_conflict",
              "Terminal result conflicts with durable outcome"
            );
        } else if (!same) {
          const updated: CommandRecord = {
            ...command,
            state: result.state,
            evidence: result.evidence,
          };
          if (result.diagnostic) updated.diagnostic = result.diagnostic;
          else delete updated.diagnostic;
          if (result.state !== "unknown")
            updated.completedAt = new Date(observed).toISOString();
          save(updated);
          audit(
            updated,
            "command.result",
            `agent:${identity.agentId}`,
            request.requestId
          );
        }
        return {
          protocolVersion: PROTOCOL_VERSION,
          environmentId: request.environmentId,
          sessionId: request.sessionId,
          requestId: request.requestId,
          receivedAt: now().toISOString(),
        };
      });
    },
    recover() {
      store.transaction(recover);
    },
    transferOwnership(identity, id) {
      return store.transaction(() => {
        verify(identity);
        const command = get(id);
        if (
          command.environmentId !== identity.environmentId ||
          command.owner?.agentId !== identity.agentId
        )
          throw new FleetError(
            "claim_owner_conflict",
            "Transfer requires the original enrolled agent"
          );
        if (command.owner.sessionId === identity.sessionId)
          return expire(command);
        command.owner = {
          agentId: identity.agentId,
          sessionId: identity.sessionId,
        };
        // Reconnection may reconcile results, never receive execution permission again.
        if (command.state === "executing") command.state = "unknown";
        save(command);
        audit(command, "command.transfer", `agent:${identity.agentId}`);
        return command;
      });
    },
    invalidateEnvironment(database, id) {
      parse(uuidSchema, id);
      return invalidate(
        database,
        db
          .prepare(
            "SELECT * FROM lifecycle_commands WHERE environment_id=? AND state='accepted'"
          )
          .all(id)
      );
    },
    invalidateProject(id) {
      parse(uuidSchema, id);
      store.transaction(() =>
        invalidate(
          db,
          db
            .prepare(
              "SELECT * FROM lifecycle_commands WHERE project_id=? AND state='accepted'"
            )
            .all(id)
        )
      );
    },
    prune() {
      return store.transaction(() => {
        recover();
        const cutoff = new Date(
          now().getTime() - LIMITS.terminalCommandRetentionMs
        ).toISOString();
        const audits = db
          .prepare(
            `DELETE FROM audit_records WHERE occurred_at<=?
          AND NOT EXISTS (SELECT 1 FROM lifecycle_commands c WHERE c.command_id=audit_records.target
            AND (c.state IN ('accepted','executing') OR (c.state='unknown' AND c.closed_at IS NULL)))`
          )
          .run(cutoff).changes;
        const commands = db
          .prepare(
            `DELETE FROM lifecycle_commands WHERE (
          (state IN ('succeeded','failed') AND completed_at<=?)
          OR (state='expired' AND expires_at<=?)
          OR (state='unknown' AND closed_at IS NOT NULL AND closed_at<=?))
          AND NOT EXISTS (SELECT 1 FROM audit_records a WHERE
            a.target=lifecycle_commands.command_id AND a.occurred_at>?)`
          )
          .run(cutoff, cutoff, cutoff, cutoff).changes;
        return { commands: Number(commands), audits: Number(audits) };
      });
    },
  };
}
