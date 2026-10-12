import { json } from "./json.js";
import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import {
  LIMITS,
  PROTOCOL_VERSION,
  readSelectionSchema,
  readResultSchema,
  resultRequestSchema,
  uuidSchema,
  type ReadRequest,
  type ReadResult,
  type ResultRequest,
  type Acknowledgment,
  type OperatorManagementClient,
  type UUID,
  type RunSummary,
} from "@gh-symphony/management-protocol";
import { FleetError, type AgentSessionCredential } from "./enrollment.js";
import type { CommandPeers, CommandTarget } from "./commands.js";
import type { FleetStore } from "./store.js";

export interface ReadService extends Pick<
  OperatorManagementClient,
  "submitRead" | "getRead"
> {
  getReadView(id: UUID): { result: ReadResult; historical: boolean };
  poll(identity: AgentSessionCredential): ReadRequest[];
  publishResult(
    identity: AgentSessionCredential,
    input: ResultRequest
  ): Promise<Acknowledgment>;
  /** Restart invalidates pending work; raw log results are never persisted. */
  recover(): void;
}
interface Entry {
  request: ReadRequest;
  target: CommandTarget;
  result: ReadResult;
  retainUntil?: number;
}

export interface ReadOptions {
  peers: CommandPeers;
  now?: () => Date;
  maximumEntries?: number;
  /** C06 owns merge/pruning of at most 100 summaries; never raw logs. */
  receiveRunSummaries?: (
    database: DatabaseSync,
    projectId: UUID,
    runs: RunSummary[],
    receivedAt: string
  ) => undefined;
}

/** Trusted API boundary: browser callers must first authenticate local-owner/CSRF. */
export function createReadService(
  store: FleetStore,
  options: ReadOptions
): ReadService {
  const maximumEntries = options.maximumEntries ?? 1024;
  if (
    !Number.isSafeInteger(maximumEntries) ||
    maximumEntries < 1 ||
    maximumEntries > 10_000
  )
    throw new Error("Invalid read registry capacity");
  const entries = new Map<UUID, Entry>();
  const now = options.now ?? (() => new Date());
  const db = store.database;
  function enrolled(target: CommandTarget): boolean {
    const environment = db
      .prepare("SELECT enrollment FROM environments WHERE id=?")
      .get(target.environmentId);
    const agent = db
      .prepare("SELECT agent_id FROM agent_credentials WHERE environment_id=?")
      .get(target.environmentId);
    return (
      environment?.enrollment === "enrolled" &&
      agent?.agent_id === target.agentId
    );
  }
  function targetChanged(
    entry: Entry,
    current: CommandTarget | undefined
  ): boolean {
    return (
      !current?.online ||
      !current.managed ||
      !enrolled(current) ||
      current.sessionId !== entry.target.sessionId ||
      current.agentId !== entry.target.agentId ||
      current.environmentId !== entry.target.environmentId ||
      current.localProjectId !== entry.target.localProjectId
    );
  }
  function unavailable(
    entry: Entry,
    code: "agent_offline" | "log_unavailable"
  ) {
    entry.result = {
      readId: entry.request.readId,
      state: "unavailable",
      diagnostic: {
        code,
        message:
          "Read target or result is unavailable; request again when online",
      },
    };
    entry.retainUntil = now().getTime() + LIMITS.completedReadRetentionMs;
  }
  function sweep() {
    const time = now().getTime();
    for (const [id, entry] of entries) {
      if (entry.result.state === "pending") {
        if (time >= Date.parse(entry.request.expiresAt)) {
          entry.result = {
            readId: id,
            state: "expired",
            diagnostic: {
              code: "log_unavailable",
              message: "Read deadline elapsed",
            },
          };
          entry.retainUntil = time + LIMITS.completedReadRetentionMs;
        } else {
          const current = options.peers.resolveTarget(
            db,
            entry.request.projectId
          );
          if (targetChanged(entry, current))
            unavailable(entry, "agent_offline");
        }
      }
      if (entry.retainUntil !== undefined && time >= entry.retainUntil)
        entries.delete(id);
    }
  }
  function verify(identity: AgentSessionCredential) {
    if (options.peers.verifyAgent(db, identity) !== true)
      throw new FleetError(
        "claim_owner_conflict",
        "Current authenticated session required"
      );
  }
  function getReadView(id: UUID): ReturnType<ReadService["getReadView"]> {
    try {
      uuidSchema.parse(id);
    } catch {
      throw new FleetError("invalid_input", "Invalid read identity");
    }
    sweep();
    const entry = entries.get(id);
    if (!entry)
      return {
        historical: true,
        result: {
          readId: id,
          state: "unavailable",
          diagnostic: {
            code: "log_unavailable",
            message: "Read is unknown, restarted or no longer retained",
          },
        },
      };
    const current = options.peers.resolveTarget(db, entry.request.projectId);
    return {
      result: structuredClone(entry.result),
      historical: targetChanged(entry, current),
    };
  }
  return {
    async submitRead(projectId, input) {
      let selection;
      try {
        uuidSchema.parse(projectId);
        selection = readSelectionSchema.parse(input);
      } catch {
        throw new FleetError("invalid_input", "Invalid read selection");
      }
      sweep();
      const target = options.peers.resolveTarget(db, projectId);
      if (!target) throw new FleetError("not_found", "Project does not exist");
      if (target.projectId !== projectId)
        throw new Error("Peer returned different project identity");
      if (!target.managed)
        throw new FleetError("project_unmanaged", "Project is unmanaged");
      if (!target.supported)
        throw new FleetError(
          "unsupported_protocol",
          "Unsupported target protocol"
        );
      if (!target.valid)
        throw new FleetError("project_invalid", "Invalid project");
      if (!target.online)
        throw new FleetError("agent_offline", "Agent is offline");
      if (!enrolled(target))
        throw new FleetError(
          "access_revoked",
          "Target enrollment is not active"
        );
      if (entries.size >= maximumEntries)
        throw new FleetError(
          "read_busy",
          "Read result registry capacity reached"
        );
      const pending = [...entries.values()].filter(
        (e) => e.result.state === "pending"
      );
      if (
        pending.filter((e) => e.target.agentId === target.agentId).length >=
          LIMITS.pendingReadsPerAgent ||
        pending.some((e) => e.request.projectId === projectId)
      )
        throw new FleetError("read_busy", "Read capacity reached");
      const request: ReadRequest = {
        readId: randomUUID(),
        projectId,
        localProjectId: target.localProjectId,
        sessionId: target.sessionId,
        submittedAt: now().toISOString(),
        expiresAt: new Date(
          now().getTime() + LIMITS.readLifetimeMs
        ).toISOString(),
        selection,
      };
      entries.set(request.readId, {
        request,
        target: structuredClone(target),
        result: { readId: request.readId, state: "pending" },
      });
      return { readId: request.readId };
    },
    async getRead(id) {
      return getReadView(id).result;
    },
    getReadView,
    poll(identity) {
      verify(identity);
      sweep();
      return [...entries.values()]
        .filter(
          (e) =>
            e.result.state === "pending" &&
            e.target.environmentId === identity.environmentId &&
            e.target.agentId === identity.agentId &&
            e.target.sessionId === identity.sessionId
        )
        .map((e) => structuredClone(e.request));
    },
    async publishResult(identity, input) {
      let request;
      try {
        request = resultRequestSchema.parse(input);
      } catch {
        throw new FleetError("invalid_input", "Invalid read result");
      }
      verify(identity);
      if (
        request.environmentId !== identity.environmentId ||
        request.sessionId !== identity.sessionId
      )
        throw new FleetError(
          "claim_owner_conflict",
          "Envelope identity mismatch"
        );
      if (request.result.kind !== "read")
        throw new FleetError(
          "invalid_input",
          "Command result belongs to command service"
        );
      sweep();
      const result = request.result.result;
      const entry = entries.get(result.readId);
      if (!entry) throw new FleetError("not_found", "Read no longer retained");
      if (
        entry.target.environmentId !== identity.environmentId ||
        entry.target.agentId !== identity.agentId ||
        entry.target.sessionId !== identity.sessionId
      )
        throw new FleetError(
          "claim_owner_conflict",
          "Read belongs to another session"
        );
      if (result.state === "completed") {
        const selection = entry.request.selection;
        const payload = result.payload;
        if (
          Buffer.byteLength(JSON.stringify(payload), "utf8") >
          LIMITS.logChunkBytes + (payload.kind === "log-chunk" ? 1024 : 0)
        )
          throw new FleetError(
            "invalid_input",
            "Read payload exceeds byte limit"
          );
        if (
          payload.kind !== selection.kind ||
          (selection.kind !== "runs" &&
            (payload.kind === "runs" || payload.runId !== selection.runId)) ||
          (selection.kind === "runs" &&
            payload.kind === "runs" &&
            payload.runs.length > selection.limit) ||
          (selection.kind === "log-chunk" &&
            payload.kind === "log-chunk" &&
            (payload.stream !== selection.stream ||
              Buffer.byteLength(payload.text, "utf8") > selection.maxBytes))
        )
          throw new FleetError(
            "invalid_input",
            "Result does not match read selection"
          );
      }
      const receivedAt = now().toISOString();
      if (entry.result.state === "pending") {
        if (
          result.state === "completed" &&
          result.payload.kind === "runs" &&
          options.receiveRunSummaries
        ) {
          const runs = structuredClone(result.payload.runs)
            .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
            .slice(0, LIMITS.runSummariesPerProject);
          store.transaction(() => {
            if (
              options.receiveRunSummaries!(
                db,
                entry.request.projectId,
                runs,
                receivedAt
              ) !== undefined
            )
              throw new Error(
                "Read projection hook must be synchronous and return undefined"
              );
          });
        }
        entry.result = readResultSchema.parse(
          result.state === "completed"
            ? { ...result, completedAt: receivedAt }
            : result
        );
        entry.retainUntil = now().getTime() + LIMITS.completedReadRetentionMs;
      } else if (entry.result.state === "completed") {
        if (
          result.state !== "completed" ||
          json(entry.result.payload) !== json(result.payload)
        )
          throw new FleetError("invalid_input", "Conflicting read result");
      }
      return {
        protocolVersion: PROTOCOL_VERSION,
        environmentId: identity.environmentId,
        sessionId: identity.sessionId,
        requestId: request.requestId,
        receivedAt,
      };
    },
    recover() {
      for (const entry of entries.values())
        if (entry.result.state === "pending")
          unavailable(entry, "log_unavailable");
    },
  };
}
