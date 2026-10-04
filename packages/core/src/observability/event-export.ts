import { Buffer } from "node:buffer";
import { redactObservabilitySecrets } from "./redaction.js";
import type { OrchestratorEvent } from "./structured-events.js";

export type EventSeverity =
  | { severityText: "INFO"; severityNumber: 9 }
  | { severityText: "WARN"; severityNumber: 13 }
  | { severityText: "ERROR"; severityNumber: 17 };

const INFO = { severityText: "INFO", severityNumber: 9 } as const;
const WARN = { severityText: "WARN", severityNumber: 13 } as const;
const ERROR = { severityText: "ERROR", severityNumber: 17 } as const;

// Deliberately matches CLI getLevel, including failures classified as INFO.
const SEVERITIES = {
  "tracker.list": INFO,
  "tracker.fetchByIds": INFO,
  "tracker.state": INFO,
  "tracker.transition-comment": INFO,
  "run-dispatched": INFO,
  "worker-credential-missing": INFO,
  "run-recovered": INFO,
  "run-restart-failed": INFO,
  "run-retried": WARN,
  "retry-postponed": INFO,
  "run-failed": ERROR,
  "run-suppressed": WARN,
  "run-ownership-skipped": WARN,
  "run-finalization-deferred": WARN,
  "convergence-lock-expired": INFO,
  "recovery-dirty-workspace": INFO,
  "hook-executed": INFO,
  "hook-failed": ERROR,
  "workspace-cleanup": INFO,
  "workspace-root-relocated": INFO,
  "worker-error": ERROR,
  turn_started: INFO,
  turn_completed: INFO,
  turn_failed: ERROR,
  session_invalidated: INFO,
  "priority.label_conflict_resolved": INFO,
  "priority.unmapped": INFO,
} satisfies Record<OrchestratorEvent["event"], EventSeverity>;

/** SDK-free severity contract; unknown future kinds use INFO. */
export function getEventSeverity(kind: string): EventSeverity {
  const severity = Object.hasOwn(SEVERITIES, kind)
    ? SEVERITIES[kind as keyof typeof SEVERITIES]
    : INFO;
  return { ...severity };
}

export const EVENT_EXPORT_LIMITS = Object.freeze({
  payloadBytes: 16 * 1024,
  scalarStringBytes: 1024,
  attributes: 64,
});

/** Append-owner context, supplied after redaction and successful persistence. */
export type EventAppendContext = {
  observedAt: string;
  projectId?: string;
  runId?: string;
  integrity?: string;
};

/** Accept legacy/future structured events, never raw worker/agent protocol data. */
export type ExportableEvent = { at: string; event: string } & Record<
  string,
  unknown
>;

export type ExportEventRecord = EventSeverity & {
  /** Milliseconds since Unix epoch; adapters convert to their SDK timestamp. */
  timestamp: number;
  observedTimestamp: number;
  body: string;
  attributes: Record<string, string | number | boolean>;
};

export type EventExportResult =
  | { ok: true; record: ExportEventRecord }
  | { ok: false; reason: "invalid_timestamp" | "invalid_payload" };

// Only structured-event schema fields enter the JSON payload. Unknown protocol
// fields (including worker text/agent params) must not cross this boundary.
const PAYLOAD_FIELDS = new Set([
  "at",
  "event",
  "projectId",
  "runId",
  "issueId",
  "issueIdentifier",
  "issueState",
  "workflowRevision",
  "sessionId",
  "threadId",
  "turnId",
  "tracker",
  "issue",
  "rateLimits",
  "requestType",
  "expectedState",
  "targetState",
  "confirmedState",
  "outcome",
  "reason",
  "error",
  "routable",
  "routableReason",
  "attempt",
  "retrySuppressed",
  "nextRetryAt",
  "retryKind",
  "dueAt",
  "lastError",
  "operation",
  "consecutiveDeferrals",
  "maxDeferrals",
  "exhausted",
  "ttlMs",
  "workspaceKey",
  "workspacePath",
  "currentBranch",
  "recoveryWorkspacePath",
  "dirtyFiles",
  "hook",
  "durationMs",
  "previousWorkspacePath",
  "configuredWorkspacePath",
  "turnCount",
  "startedAt",
  "tokenUsage",
  "replacementSessionId",
  "matched",
  "chosenValue",
  "chosenLabels",
  "source",
  "rawValues",
]);

const SCALAR_FIELDS = [
  "issueState",
  "workflowRevision",
  "requestType",
  "expectedState",
  "targetState",
  "confirmedState",
  "outcome",
  "reason",
  "error",
  "lastError",
  "routable",
  "routableReason",
  "attempt",
  "retrySuppressed",
  "nextRetryAt",
  "retryKind",
  "dueAt",
  "operation",
  "consecutiveDeferrals",
  "maxDeferrals",
  "exhausted",
  "ttlMs",
  "hook",
  "durationMs",
  "turnCount",
  "startedAt",
  "source",
  "chosenValue",
] as const;

/**
 * Pure, transport-independent projection. No clocks, tracker reads, mutation,
 * persistence or SDK imports. Mapping failure affects only this export record;
 * the owner counts it without changing local append semantics.
 */
export function normalizeEventForExport(
  event: OrchestratorEvent | ExportableEvent,
  context: EventAppendContext
): EventExportResult {
  const timestamp = parseTimestamp(event.at);
  const observedTimestamp = parseTimestamp(context.observedAt);
  if (timestamp === null || observedTimestamp === null) {
    return { ok: false, reason: "invalid_timestamp" };
  }

  try {
    const payload = Object.fromEntries(
      Object.entries(event).filter(([key]) => PAYLOAD_FIELDS.has(key))
    );
    // Defense in depth: callers supply redacted append input; context and all
    // extracted attributes also pass through the existing redactor here.
    const safe = redactObservabilitySecrets(payload);
    const safeContext = redactObservabilitySecrets(context);
    const serialized = JSON.stringify(safe);
    const attributes: ExportEventRecord["attributes"] = {};
    const put = (key: string, value: unknown) => {
      if (Object.keys(attributes).length >= EVENT_EXPORT_LIMITS.attributes)
        return;
      if (typeof value === "string" && value.length > 0) {
        attributes[key] = truncateUtf8(
          value,
          EVENT_EXPORT_LIMITS.scalarStringBytes
        );
      } else if (
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value))
      ) {
        attributes[key] = value;
      }
    };
    const issue = asRecord(safe.issue);
    const issueId = nonemptyString(issue.id) ?? nonemptyString(safe.issueId);
    const issueIdentifier =
      nonemptyString(issue.identifier) ?? nonemptyString(safe.issueIdentifier);
    put("symphony.issue.id", issueId);
    put("symphony.issue.identifier", issueIdentifier);
    put(
      "symphony.project.id",
      nonemptyString(safe.projectId) ?? safeContext.projectId
    );
    put("symphony.run.id", nonemptyString(safe.runId) ?? safeContext.runId);
    put("symphony.session.id", nonemptyString(safe.sessionId));
    put("symphony.turn.id", nonemptyString(safe.turnId));
    put("symphony.event.integrity", nonemptyString(safeContext.integrity));
    const tracker = asRecord(safe.tracker);
    put("symphony.tracker.kind", nonemptyString(tracker.adapter));
    put("symphony.project.slug", nonemptyString(tracker.projectSlug));
    for (const field of SCALAR_FIELDS)
      put(`symphony.event.${field}`, safe[field]);
    const usage = asRecord(safe.tokenUsage);
    for (const field of ["inputTokens", "outputTokens", "totalTokens"]) {
      put(`symphony.event.tokenUsage.${field}`, usage[field]);
    }

    const knownIssueEvent =
      Object.hasOwn(SEVERITIES, event.event) &&
      event.event !== "hook-executed" &&
      event.event !== "hook-failed";
    if (
      (knownIssueEvent || issueId || issueIdentifier || safe.issue) &&
      (!issueId || !issueIdentifier)
    ) {
      put("symphony.context.incomplete", true);
    }
    if (
      Buffer.byteLength(serialized, "utf8") > EVENT_EXPORT_LIMITS.payloadBytes
    ) {
      put("symphony.payload.truncated", true);
    }
    // Payload alone is exempt from the ordinary 1 KiB scalar limit. A truncated
    // JSON prefix need not parse as JSON; the explicit marker identifies it.
    attributes["symphony.event.payload"] = truncateUtf8(
      serialized,
      EVENT_EXPORT_LIMITS.payloadBytes
    );
    return {
      ok: true,
      record: {
        ...getEventSeverity(event.event),
        timestamp,
        observedTimestamp,
        body: truncateUtf8(
          String(safe.event),
          EVENT_EXPORT_LIMITS.scalarStringBytes
        ),
        attributes,
      },
    };
  } catch {
    // JSON-incompatible legacy input (e.g. cycles/BigInt) must not fail append.
    return { ok: false, reason: "invalid_payload" };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseTimestamp(value: string): number | null {
  // Require ISO/RFC3339, not Date.parse's permissive locale/numeric formats.
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value
    )
  )
    return null;
  if (Number(value.slice(11, 13)) > 23) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  // Date.parse normalizes impossible calendar dates, so validate the day too.
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const days = new Date(0);
  days.setUTCFullYear(year, month, 0);
  return month >= 1 && month <= 12 && day >= 1 && day <= days.getUTCDate()
    ? timestamp
    : null;
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  while ((bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}
