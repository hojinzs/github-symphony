import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EVENT_EXPORT_LIMITS,
  getEventSeverity,
  normalizeEventForExport,
  type ExportableEvent,
  type ExportEventRecord,
  type OrchestratorEvent,
  parseRunEventLine,
  redactObservabilitySecrets,
} from "../index.js";

const at = "2026-10-04T10:00:00.123Z";
const context = {
  observedAt: "2026-10-04T10:00:01.456Z",
  projectId: "append-project",
  runId: "append-run",
  integrity: "sha256:fixture",
};
const issue = { id: "issue-1", identifier: "ENG-1" };
const flat = { issueId: issue.id, issueIdentifier: issue.identifier };
const tracker = { adapter: "file", projectSlug: "sample/project" };
const tokenUsage = { inputTokens: 2, outputTokens: 3, totalTokens: 5 };

// Exhaustive fixture keys make new structured discriminants require coverage.
const fixtures = {
  "tracker.list": {
    at,
    event: "tracker.list",
    projectId: "project-1",
    issue,
    tracker,
  },
  "tracker.fetchByIds": {
    at,
    event: "tracker.fetchByIds",
    projectId: "project-1",
    issue,
    tracker,
  },
  "tracker.state": {
    at,
    event: "tracker.state",
    projectId: "project-1",
    runId: "run-1",
    issue,
    tracker,
    requestType: "state-read",
    expectedState: null,
    targetState: null,
    confirmedState: "Ready",
    outcome: "confirmed",
    reason: null,
    error: null,
  },
  "tracker.transition-comment": {
    at,
    event: "tracker.transition-comment",
    projectId: "project-1",
    runId: "run-1",
    issue,
    tracker,
    expectedState: "Ready",
    targetState: "In progress",
    outcome: "created",
    error: null,
  },
  "run-dispatched": {
    at,
    event: "run-dispatched",
    projectId: "project-1",
    ...flat,
  },
  "worker-credential-missing": {
    at,
    event: "worker-credential-missing",
    projectId: "project-1",
    runId: "run-1",
    ...flat,
    tracker,
  },
  "run-recovered": { at, event: "run-recovered", ...flat },
  "run-restart-failed": {
    at,
    event: "run-restart-failed",
    runId: "run-1",
    ...flat,
    attempt: 1,
    error: "restart failed",
    retrySuppressed: false,
  },
  "run-retried": {
    at,
    event: "run-retried",
    runId: "run-1",
    ...flat,
    attempt: 2,
    retryKind: "failure",
    dueAt: at,
    error: null,
  },
  "retry-postponed": {
    at,
    event: "retry-postponed",
    runId: "run-1",
    ...flat,
    attempt: 2,
    dueAt: at,
    reason: "capacity",
  },
  "run-failed": {
    at,
    event: "run-failed",
    ...flat,
    attempt: 1,
    lastError: "failed",
  },
  "run-suppressed": { at, event: "run-suppressed", ...flat, reason: "budget" },
  "run-ownership-skipped": {
    at,
    event: "run-ownership-skipped",
    projectId: "project-1",
    runId: "run-1",
    ...flat,
    operation: "signal",
    reason: "owner-alive",
  },
  "run-finalization-deferred": {
    at,
    event: "run-finalization-deferred",
    projectId: "project-1",
    runId: "run-1",
    ...flat,
    reason: "tracker-read-failed",
    error: "unavailable",
    consecutiveDeferrals: 1,
    maxDeferrals: 3,
    exhausted: false,
  },
  "convergence-lock-expired": {
    at,
    event: "convergence-lock-expired",
    runId: "run-1",
    ...flat,
    ttlMs: 1000,
    reason: "ttl_expired",
  },
  "recovery-dirty-workspace": {
    at,
    event: "recovery-dirty-workspace",
    ...flat,
    workspaceKey: "workspace-1",
    workspacePath: "/tmp/work",
    currentBranch: null,
    recoveryWorkspacePath: null,
    dirtyFiles: ["source.ts"],
  },
  "hook-executed": {
    at,
    event: "hook-executed",
    hook: "before_run",
    outcome: "success",
    durationMs: 0,
  },
  "hook-failed": {
    at,
    event: "hook-failed",
    hook: "before_run",
    error: "failed",
  },
  "workspace-cleanup": {
    at,
    event: "workspace-cleanup",
    ...flat,
    workspaceKey: "workspace-1",
    outcome: "removed",
  },
  "workspace-root-relocated": {
    at,
    event: "workspace-root-relocated",
    ...flat,
    workspaceKey: "workspace-1",
    previousWorkspacePath: "/tmp/old",
    configuredWorkspacePath: "/tmp/new",
  },
  "worker-error": {
    at,
    event: "worker-error",
    runId: "run-1",
    ...flat,
    error: "failed",
    attempt: 1,
  },
  turn_started: {
    at,
    event: "turn_started",
    ...flat,
    sessionId: "session-1",
    turnId: "turn-1",
    turnCount: 1,
  },
  turn_completed: {
    at,
    event: "turn_completed",
    ...flat,
    sessionId: "session-1",
    turnId: "turn-1",
    turnCount: 1,
    startedAt: at,
    durationMs: 1000,
    tokenUsage,
  },
  turn_failed: {
    at,
    event: "turn_failed",
    ...flat,
    sessionId: "session-1",
    turnId: "turn-1",
    turnCount: 1,
    startedAt: at,
    durationMs: 1000,
    tokenUsage,
    error: "failed",
  },
  session_invalidated: {
    at,
    event: "session_invalidated",
    runId: "run-1",
    ...flat,
    sessionId: "session-1",
    replacementSessionId: "session-2",
    reason: "stale",
  },
  "priority.label_conflict_resolved": {
    at,
    event: "priority.label_conflict_resolved",
    issue,
    matched: [{ label: "p1", value: 1 }],
    chosenValue: 1,
    chosenLabels: ["p1"],
  },
  "priority.unmapped": {
    at,
    event: "priority.unmapped",
    issue,
    source: "labels",
    rawValues: ["unknown"],
  },
} satisfies {
  [K in OrchestratorEvent["event"]]: Extract<OrchestratorEvent, { event: K }>;
};

const errors = ["run-failed", "turn_failed", "worker-error", "hook-failed"];
const warnings = [
  "run-suppressed",
  "run-retried",
  "run-finalization-deferred",
  "run-ownership-skipped",
];

function project(
  event: OrchestratorEvent | ExportableEvent
): ExportEventRecord {
  const result = normalizeEventForExport(event, context);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.record;
}

const event = (overrides: Record<string, unknown> = {}): ExportableEvent => ({
  at,
  event: "run-dispatched",
  ...flat,
  ...overrides,
});

describe("OT-01 SDK-free event projection", () => {
  it.each(Object.values(fixtures))(
    "maps severity and context for $event",
    (fixture) => {
      const record = project(fixture);
      const severityText = errors.includes(fixture.event)
        ? "ERROR"
        : warnings.includes(fixture.event)
          ? "WARN"
          : "INFO";
      expect(record.severityText).toBe(severityText);
      expect(record.severityNumber).toBe(
        severityText === "ERROR" ? 17 : severityText === "WARN" ? 13 : 9
      );
      expect(getEventSeverity(fixture.event)).toEqual({
        severityText: record.severityText,
        severityNumber: record.severityNumber,
      });
      expect(record.body).toBe(fixture.event);
      expect(record.timestamp).toBe(Date.parse(at));
      expect(record.observedTimestamp).toBe(Date.parse(context.observedAt));
      expect(record.attributes["symphony.project.id"]).toBe(
        "projectId" in fixture ? fixture.projectId : context.projectId
      );
      expect(record.attributes["symphony.run.id"]).toBe(
        "runId" in fixture ? fixture.runId : context.runId
      );
      expect(record.attributes["symphony.event.integrity"]).toBe(
        context.integrity
      );
      if (
        fixture.event !== "hook-executed" &&
        fixture.event !== "hook-failed"
      ) {
        expect(record.attributes["symphony.issue.id"]).toBe(issue.id);
        expect(record.attributes["symphony.issue.identifier"]).toBe(
          issue.identifier
        );
      }
      expect(record.attributes).not.toHaveProperty(
        "symphony.context.incomplete"
      );
      expect(
        JSON.parse(String(record.attributes["symphony.event.payload"]))
      ).toEqual(fixture);
      expect(Object.keys(record.attributes).length).toBeLessThanOrEqual(64);
    }
  );

  it.each(["future-event", "toString", "__proto__"])(
    "defaults unknown %s to INFO",
    (kind) => {
      expect(project(event({ event: kind })).severityNumber).toBe(9);
      expect(getEventSeverity(kind)).toEqual({
        severityText: "INFO",
        severityNumber: 9,
      });
    }
  );

  it("prefers nested issue fields and explicit run/project IDs over append context", () => {
    const record = project(
      event({
        issue: { id: "nested-id", identifier: "NEST-2" },
        projectId: "event-project",
        runId: "event-run",
        sessionId: "session",
        turnId: "turn",
      })
    );
    expect(record.attributes).toMatchObject({
      "symphony.issue.id": "nested-id",
      "symphony.issue.identifier": "NEST-2",
      "symphony.project.id": "event-project",
      "symphony.run.id": "event-run",
      "symphony.session.id": "session",
      "symphony.turn.id": "turn",
    });
  });

  it("falls back on empty nested IDs and empty run/project fields", () => {
    expect(
      project(
        event({ issue: { id: "", identifier: null }, projectId: "", runId: "" })
      ).attributes
    ).toMatchObject({
      "symphony.issue.id": issue.id,
      "symphony.issue.identifier": issue.identifier,
      "symphony.project.id": context.projectId,
      "symphony.run.id": context.runId,
    });
  });

  it("omits absent optional context, never infers sessions, and flags incomplete issues", () => {
    const input = event({
      issueId: null,
      sessionId: null,
      turnId: "",
      error: null,
      reason: "",
      attempt: NaN,
    });
    const record = project(input);
    expect(record.attributes["symphony.context.incomplete"]).toBe(true);
    for (const key of [
      "issue.id",
      "session.id",
      "turn.id",
      "event.error",
      "event.reason",
      "event.attempt",
    ])
      expect(record.attributes).not.toHaveProperty(`symphony.${key}`);
    const result = normalizeEventForExport(input, {
      observedAt: context.observedAt,
    });
    expect(result.ok && result.record.attributes).not.toHaveProperty(
      "symphony.run.id"
    );
    expect(result.ok && result.record.attributes).not.toHaveProperty(
      "symphony.project.id"
    );
    expect(result.ok && result.record.attributes).not.toHaveProperty(
      "symphony.event.integrity"
    );
    expect(project(fixtures["hook-executed"]).attributes).not.toHaveProperty(
      "symphony.context.incomplete"
    );
  });

  it("preserves typed scalars including zero and false", () => {
    const record = project(
      event({
        outcome: "confirmed",
        reason: "capacity",
        error: "failure",
        attempt: 0,
        durationMs: 0,
        retrySuppressed: false,
        tokenUsage,
        tracker,
      })
    );
    expect(record.attributes).toMatchObject({
      "symphony.event.outcome": "confirmed",
      "symphony.event.reason": "capacity",
      "symphony.event.error": "failure",
      "symphony.event.attempt": 0,
      "symphony.event.durationMs": 0,
      "symphony.event.retrySuppressed": false,
      "symphony.event.tokenUsage.inputTokens": 2,
      "symphony.event.tokenUsage.outputTokens": 3,
      "symphony.event.tokenUsage.totalTokens": 5,
      "symphony.tracker.kind": "file",
      "symphony.project.slug": "sample/project",
    });
  });

  it.each([
    "invalid",
    "2026-02-30T10:00:00Z",
    "2026-10-04T24:00:00Z",
    "2026-10-04",
    "2026-10-04T10:61:00Z",
  ])("rejects malformed timestamp %s only in the export result", (invalid) => {
    const input = event({ at: invalid });
    expect(normalizeEventForExport(input, context)).toEqual({
      ok: false,
      reason: "invalid_timestamp",
    });
    expect(input.at).toBe(invalid);
    expect(
      normalizeEventForExport(event(), { ...context, observedAt: invalid })
    ).toEqual({ ok: false, reason: "invalid_timestamp" });
  });

  it("accepts ISO offsets and leap days", () => {
    expect(project(event({ at: "2024-02-29T12:00:00+02:00" })).timestamp).toBe(
      Date.parse("2024-02-29T10:00:00Z")
    );
  });

  it("preserves redacted event values and redacts append context", () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
    const input = event({
      error: `Authorization: Bearer ${secret}`,
      reason: `token=${secret}`,
      rateLimits: { apiKey: "secret-value" },
    });
    const redactedInput = redactObservabilitySecrets(input);
    const result = normalizeEventForExport(redactedInput, {
      ...context,
      runId: `token=${secret}`,
    });
    const output = JSON.stringify(result);
    expect(output).not.toContain(secret);
    expect(output).not.toContain("secret-value");
    expect(output).toContain("[REDACTED]");
    expect(input.error).toContain(secret);
    expect(
      result.ok && result.record.attributes["symphony.event.payload"]
    ).toBe(JSON.stringify(redactedInput));
  });

  it("excludes raw worker text, agent params and trace/span fields", () => {
    const record = project(
      event({
        params: { text: "raw-protocol" },
        workerText: "raw-worker",
        traceId: "raw-trace",
        spanId: "raw-span",
      })
    );
    const exported = JSON.stringify(record);
    for (const value of ["raw-protocol", "raw-worker", "raw-trace", "raw-span"])
      expect(exported).not.toContain(value);
  });

  it("keeps payloads above 1 KiB intact below 16 KiB while bounding scalar strings", () => {
    const reason = "🙂".repeat(1000);
    const record = project(event({ reason }));
    expect(
      JSON.parse(String(record.attributes["symphony.event.payload"])).reason
    ).toBe(reason);
    expect(record.attributes).not.toHaveProperty("symphony.payload.truncated");
    expect(record.attributes["symphony.event.reason"]).toBe("🙂".repeat(256));
  });

  it("truncates payload at a UTF-8 boundary while preserving context", () => {
    const record = project(
      event({
        reason: "界🙂".repeat(5000),
        sessionId: "session-1",
        turnId: "turn-1",
      })
    );
    const payload = String(record.attributes["symphony.event.payload"]);
    expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(
      EVENT_EXPORT_LIMITS.payloadBytes
    );
    expect(Buffer.byteLength(payload)).toBeGreaterThan(
      EVENT_EXPORT_LIMITS.payloadBytes - 4
    );
    expect(payload).not.toContain("\uFFFD");
    expect(record.attributes).toMatchObject({
      "symphony.payload.truncated": true,
      "symphony.issue.id": issue.id,
      "symphony.run.id": context.runId,
      "symphony.session.id": "session-1",
      "symphony.turn.id": "turn-1",
    });
    expect(Object.keys(record.attributes).length).toBeLessThanOrEqual(64);
  });

  it("returns mapping failure for JSON-incompatible payloads", () => {
    const input = event({ attempt: 1n });
    expect(normalizeEventForExport(input, context)).toEqual({
      ok: false,
      reason: "invalid_payload",
    });
  });
});

describe("OT-07 local schema preservation", () => {
  it("preserves persisted secret-like values across repeated projections", () => {
    const input = redactObservabilitySecrets(
      event({
        lastError: "Authorization: Bearer secret-value",
        error: "https://user:pw@host/x?token=secret-value",
      })
    );
    const persisted = JSON.stringify(input);
    expect(persisted).toContain("[REDACTED]");
    for (let i = 0; i < 2; i++) {
      const record = project(input);
      expect(record.attributes["symphony.event.payload"]).toBe(persisted);
      expect(record.attributes["symphony.event.lastError"]).toBe(
        input.lastError
      );
      expect(record.attributes["symphony.event.error"]).toBe(input.error);
      expect(JSON.stringify(input)).toBe(persisted);
    }
  });

  it("leaves redacted append input, context, NDJSON bytes and integrity unchanged", () => {
    const input = redactObservabilitySecrets(fixtures.turn_completed);
    const json = JSON.stringify(input);
    const integrity = `sha256:${createHash("sha256").update(json).digest("hex")}`;
    const bytes = `${json.slice(0, -1)},"integrity":"${integrity}"}\n`;
    const appendContext = { ...context, integrity };
    const originalContext = JSON.stringify(appendContext);
    Object.freeze(input);
    Object.freeze(input.tokenUsage);
    const result = normalizeEventForExport(input, appendContext);
    expect(
      result.ok && result.record.attributes["symphony.event.integrity"]
    ).toBe(integrity);
    expect(JSON.stringify(input)).toBe(json);
    expect(JSON.stringify(appendContext)).toBe(originalContext);
    expect(
      `${JSON.stringify(input).slice(0, -1)},"integrity":"${integrity}"}\n`
    ).toBe(bytes);
    expect(parseRunEventLine(bytes)).toMatchObject({
      event: "turn_completed",
      sessionId: "session-1",
      tokenUsage,
    });
    expect(input).not.toHaveProperty("runId");
  });
});
