import { describe, expect, it } from "vitest";
import * as S from "./schemas.js";
import { ProtocolValidationError, type Schema } from "./validation.js";
import { LIMITS } from "./constants.js";
import type { AgentControlPlaneClient, CommandRecord } from "./contracts.js";
import * as F from "../test-fixtures/v1.js";
function wire<T>(value: T): unknown {
  return JSON.parse(JSON.stringify(value));
}
function rejects<T>(schema: Schema<T>, inputs: unknown[]) {
  for (const input of inputs)
    expect(() => schema.parse(input)).toThrow(ProtocolValidationError);
}

describe("v1 peer wire boundary", () => {
  it("validates opaque IDs, UTC timestamps and finite JSON without coercion", () => {
    expect(S.uuidSchema.parse(F.projectId)).toBe(F.projectId);
    expect(S.timestampSchema.parse(F.time)).toBe(F.time);
    expect(S.jsonValueSchema.parse({ nested: [true, null, 2] })).toEqual({
      nested: [true, null, 2],
    });
    rejects(S.uuidSchema, ["../project", "project-folder-hash", 1]);
    rejects(S.timestampSchema, [
      "2026-02-30T00:00:00Z",
      "2026-10-05T00:00:00+00:00",
      "2026-10-05",
      "2026-10-05T25:00:00Z",
    ]);
    rejects(S.jsonValueSchema, [
      Infinity,
      NaN,
      undefined,
      { secret: undefined },
      new Date(),
      Array(1),
    ]);
    const cycle: unknown[] = [];
    cycle.push(cycle);
    rejects(S.jsonValueSchema, [cycle]);
  });
  it("enforces strict shapes and safe sequences while preserving stale snapshot diagnostics", () => {
    expect(S.observationRequestSchema.parse(wire(F.observation))).toEqual(
      F.observation
    );
    const stale = {
      ...F.observation,
      inventory: {
        ...F.observation.inventory,
        projects: [
          {
            ...F.observation.inventory.projects[0],
            validation: {
              state: "invalid",
              diagnostic: {
                code: "project_invalid",
                message: "Missing workflow",
              },
            },
            snapshotError: {
              code: "process_unverified",
              message: "Status read failed",
            },
          },
        ],
      },
    };
    expect(
      S.observationRequestSchema.parse(stale).inventory.projects[0].process
        .state
    ).toBe("running");
    rejects(S.observationRequestSchema, [
      null,
      { ...F.observation, protocolVersion: 2 },
      { ...F.observation, sequence: -1 },
      { ...F.observation, sequence: 1.5 },
      { ...F.observation, sequence: Number.MAX_SAFE_INTEGER + 1 },
      { ...F.observation, bearerCredential: "must-not-upload" },
      {
        ...F.observation,
        inventory: { ...F.observation.inventory, pageIndex: 1 },
      },
      {
        ...F.observation,
        inventory: {
          ...F.observation.inventory,
          projects: [
            F.observation.inventory.projects[0],
            F.observation.inventory.projects[0],
          ],
        },
      },
    ]);
    rejects(S.processObservationSchema, [
      { state: "running", observedAt: F.time },
      { state: "stopped", observedAt: F.time, pid: 42 },
      { state: "unknown", observedAt: F.time },
    ]);
    expect(
      S.observationRequestSchema.parse({
        ...F.observation,
        inventory: { ...F.observation.inventory, projects: [] },
      }).inventory.projects
    ).toEqual([]);
  });
  it("bounds inventory, UTF-8 observation bodies and run summaries", () => {
    const project = F.observation.inventory.projects[0];
    expect(S.parseObservationBody(JSON.stringify(F.observation))).toEqual(
      F.observation
    );
    expect(() => S.parseObservationBody("not-json")).toThrow(
      ProtocolValidationError
    );
    expect(() =>
      S.parseObservationBody(
        " ".repeat(LIMITS.observationBodyBytes) + JSON.stringify(F.observation)
      )
    ).toThrow(ProtocolValidationError);
    rejects(S.observationRequestSchema, [
      {
        ...F.observation,
        inventory: {
          ...F.observation.inventory,
          projects: Array.from({ length: 101 }, () => project),
        },
      },
      {
        ...F.observation,
        inventory: {
          ...F.observation.inventory,
          projects: [
            {
              ...project,
              snapshot: "é".repeat(LIMITS.observationBodyBytes / 2),
            },
          ],
        },
      },
    ]);
    rejects(S.projectObservationSchema, [
      { ...project, runs: Array(101).fill(project.runs[0]) },
      { ...project, canonicalPath: "relative/path" },
    ]);
    expect(
      S.projectObservationSchema.parse({
        ...project,
        runs: Array(100).fill(project.runs[0]),
      }).runs
    ).toHaveLength(100);
  });
  it("preserves claim replay, terminal evidence and unknown closure without new permission", () => {
    for (const record of [
      F.accepted,
      F.executing,
      F.unknown,
      F.closedUnknown,
      { ...F.accepted, state: "expired" },
      { ...F.executing, state: "succeeded", completedAt: F.time },
    ])
      expect(S.commandRecordSchema.parse(wire(record))).toEqual(record);
    expect(
      S.claimResponseSchema.parse(wire(F.claimReplay)).command.claimedAt
    ).toBe("2026-10-05T00:00:20Z");
    rejects(S.commandRecordSchema, [
      { ...F.accepted, state: "unknown" },
      { ...F.accepted, owner: F.executing.owner },
      { ...F.executing, claimedAt: undefined },
      { ...F.executing, state: "succeeded" },
      { ...F.accepted, closure: F.closedUnknown.closure },
      { ...F.unknown, completedAt: F.time },
    ]);
    rejects(S.claimResponseSchema, [
      { ...F.claimReplay, environmentId: F.otherEnvironmentId },
    ]);
    rejects(S.closeUnresolvedRequestSchema, [
      { acknowledged: false, reason: "inspected" },
      { acknowledged: true, reason: "   " },
    ]);
    expect(
      S.closeUnresolvedRequestSchema.parse({
        acknowledged: true,
        reason: "Host inspected",
      }).acknowledged
    ).toBe(true);
  });
  it("fences poll target envelopes and bounds independent lifecycle/read lanes", () => {
    expect(S.pollResponseSchema.parse(wire(F.poll))).toEqual(F.poll);
    rejects(S.pollResponseSchema, [
      {
        ...F.poll,
        commands: [
          { ...F.poll.commands[0], environmentId: F.otherEnvironmentId },
        ],
      },
      {
        ...F.poll,
        commands: [{ ...F.poll.commands[0], sessionId: F.agentId }],
      },
      { ...F.poll, reads: [{ ...F.poll.reads[0], sessionId: F.agentId }] },
      { ...F.poll, commands: Array(5).fill(F.poll.commands[0]) },
      { ...F.poll, reads: Array(5).fill(F.poll.reads[0]) },
      { ...F.poll, commands: [F.poll.commands[0], F.poll.commands[0]] },
      { ...F.poll, reads: [F.poll.reads[0], F.poll.reads[0]] },
    ]);
  });
  it("selects known log streams and preserves explicit reset/expired/unavailable read outcomes", () => {
    expect(S.readSelectionSchema.parse(wire(F.logSelection))).toEqual(
      F.logSelection
    );
    rejects(S.readSelectionSchema, [
      { ...F.logSelection, path: "../../secret" },
      { ...F.logSelection, stream: "../../secret" },
      { ...F.logSelection, maxBytes: 262145 },
      { ...F.logSelection, maxBytes: 0 },
      { kind: "runs", limit: 101 },
    ]);
    const payload = {
      kind: "log-chunk",
      runId: "local-run-1",
      stream: "worker",
      text: "é".repeat(131072),
      cursor: "generation:offset",
      reset: true,
      eof: false,
    };
    expect(S.readPayloadSchema.parse(payload)).toEqual(payload);
    rejects(S.readPayloadSchema, [{ ...payload, text: payload.text + "a" }]);
    for (const state of ["expired", "unavailable"])
      expect(
        S.readResultSchema.parse({
          readId: F.requestId,
          state,
          diagnostic: { code: "log_unavailable", message: "Read unavailable" },
        }).state
      ).toBe(state);
    rejects(S.readResultSchema, [
      { readId: F.requestId, state: "expired" },
      { readId: F.requestId, state: "completed", completedAt: F.time },
    ]);
    rejects(S.agentResultSchema, [
      { kind: "read", result: { readId: F.requestId, state: "pending" } },
    ]);
  });
  it("separates enrollment from first signal and keeps aggregate/local identity scoped", () => {
    expect(S.environmentRecordSchema.parse(F.awaiting).connection).toBe(
      "awaiting-signal"
    );
    expect(
      S.environmentRecordSchema.parse({
        ...F.awaiting,
        connection: "online",
        lastContactAt: F.time,
      }).connection
    ).toBe("online");
    rejects(S.environmentRecordSchema, [
      { ...F.awaiting, connection: "online" },
      {
        ...F.awaiting,
        enrollment: "revoked",
        connection: "online",
        lastContactAt: F.time,
      },
    ]);
    const second = {
      ...F.aggregate,
      environmentId: F.otherEnvironmentId,
      projectId: F.agentId,
      observation: { ...F.aggregate.observation, projectId: F.agentId },
    };
    expect(S.aggregateProjectSchema.parse(second).environmentId).not.toBe(
      S.aggregateProjectSchema.parse(F.aggregate).environmentId
    );
    rejects(S.aggregateProjectSchema, [
      { ...F.aggregate, localProjectId: "other" },
      { ...F.aggregate, projectId: F.agentId },
    ]);
    rejects(S.pageRequestSchema, [{ limit: 101 }, { limit: 0 }]);
    expect(
      S.pageSchema(S.aggregateProjectSchema).parse({
        items: [F.aggregate, second],
      }).items
    ).toHaveLength(2);
  });
  it("exercises typed future client operations over independently authored serialized peer fixtures", async () => {
    const client: AgentControlPlaneClient = {
      async enroll(request) {
        S.enrollmentRequestSchema.parse(wire(request));
        return S.enrollmentResponseSchema.parse(wire(F.enrolled));
      },
      async openSession(request) {
        S.sessionRequestSchema.parse(wire(request));
        return S.sessionResponseSchema.parse(wire(F.opened));
      },
      async observe(request) {
        S.observationRequestSchema.parse(wire(request));
        return S.acknowledgmentSchema.parse({
          ...F.envelope,
          receivedAt: F.time,
        });
      },
      async poll(request) {
        S.pollRequestSchema.parse(wire(request));
        return S.pollResponseSchema.parse(wire(F.poll));
      },
      async claim(request) {
        S.claimRequestSchema.parse(wire(request));
        return S.claimResponseSchema.parse(wire(F.claimReplay));
      },
      async publishResult(request) {
        S.resultRequestSchema.parse(wire(request));
        return S.acknowledgmentSchema.parse({
          ...F.envelope,
          receivedAt: F.time,
        });
      },
    };
    expect(await client.enroll(F.enrollment)).toEqual(F.enrolled);
    expect(await client.openSession(F.session)).toEqual(F.opened);
    await client.observe(F.observation);
    expect((await client.poll(F.envelope)).commands[0].commandId).toBe(
      F.commandId
    );
    const replay: CommandRecord = (
      await client.claim({ ...F.envelope, commandId: F.commandId })
    ).command;
    expect(replay).toEqual(F.executing);
    await client.publishResult(F.result);
    await expect(client.enroll({ ...F.enrollment, token: "" })).rejects.toThrow(
      ProtocolValidationError
    );
    await expect(
      client.publishResult({
        ...F.result,
        protocolVersion: 2,
      } as unknown as Parameters<AgentControlPlaneClient["publishResult"]>[0])
    ).rejects.toThrow(ProtocolValidationError);
  });
});

it("validates operator and error wire contracts with explicit extra-field rejection", () => {
  const fixtures: [Schema<unknown>, Record<string, unknown>][] = [
    [
      S.errorResponseSchema,
      {
        error: {
          code: "agent_busy",
          message: "Four commands active",
          requestId: F.requestId,
        },
      },
    ],
    [
      S.projectIdentitySchema,
      {
        projectId: F.projectId,
        environmentId: F.environmentId,
        localProjectId: "folder-hash",
      },
    ],
    [S.createEnvironmentRequestSchema, { name: "Prepared host" }],
    [
      S.enrollmentTokenResponseSchema,
      {
        environmentId: F.environmentId,
        token: "fixture-only",
        expiresAt: F.time,
      },
    ],
    [S.submitCommandRequestSchema, { operation: "start" }],
    [
      S.submitCommandResponseSchema,
      { commandId: F.commandId, state: "accepted" },
    ],
    [
      S.projectFilterSchema,
      {
        limit: 25,
        environmentId: F.environmentId,
        process: "unknown",
        connection: "offline",
      },
    ],
    [S.readRequestSchema, F.poll.reads[0]],
    [
      S.readResultSchema,
      {
        readId: F.requestId,
        state: "completed",
        completedAt: F.time,
        payload: {
          kind: "runs",
          runs: F.observation.inventory.projects[0].runs,
        },
      },
    ],
    [
      S.readPayloadSchema,
      {
        kind: "run-detail",
        runId: "local-run-1",
        detail: { status: "running" },
      },
    ],
    [S.readSelectionSchema, { kind: "runs", limit: 100 }],
    [S.readSelectionSchema, { kind: "run-detail", runId: "local-run-1" }],
    [
      S.resultRequestSchema,
      {
        ...F.envelope,
        result: {
          kind: "read",
          result: {
            readId: F.requestId,
            state: "unavailable",
            diagnostic: {
              code: "log_unavailable",
              message: "Service restarted",
            },
          },
        },
      },
    ],
    [S.processObservationSchema, { state: "stopped", observedAt: F.time }],
    [
      S.processObservationSchema,
      {
        state: "unknown",
        observedAt: F.time,
        diagnostic: { code: "process_unverified", message: "No evidence" },
      },
    ],
  ];
  for (const [validator, value] of fixtures) {
    expect(validator.parse(wire(value))).toEqual(value);
    rejects(validator, [{ ...value, unexpected: "fixture-secret" }]);
  }
  const secret = "fixture-secret-do-not-echo";
  try {
    S.enrollmentRequestSchema.parse({ ...F.enrollment, token: { secret } });
  } catch (error) {
    expect(String(error)).not.toContain(secret);
  }
});
