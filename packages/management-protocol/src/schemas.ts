import {
  COMMAND_STATES,
  ERROR_CODES,
  LIMITS,
  LOG_STREAMS,
  OPERATOR_ACTOR,
  PROTOCOL_VERSION,
} from "./constants.js";
import type * as C from "./contracts.js";
import {
  array,
  boolean,
  enumeration,
  fail,
  integer,
  literal,
  object,
  optional,
  refine,
  schema,
  text,
  union,
  utf8Bytes,
  type Schema,
} from "./validation.js";

export const uuidSchema = refine(
  text,
  (v) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
  "expected opaque UUID"
);
export const timestampSchema = refine(
  text,
  (v) => {
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?Z$/.exec(v);
    if (!match || !Number.isFinite(Date.parse(v))) return false;
    return new Date(v).toISOString().slice(0, 19) === match[1];
  },
  "expected valid UTC RFC3339 timestamp"
);
export const jsonValueSchema: Schema<C.JsonValue> = schema((value, path) => {
  function visit(v: unknown, depth: number): C.JsonValue {
    if (depth > 64) fail(path, "JSON nesting exceeds 64 levels");
    if (v === null || typeof v === "boolean" || typeof v === "string") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (Array.isArray(v))
      return Array.from(v, (item) => visit(item, depth + 1));
    if (
      typeof v === "object" &&
      v !== null &&
      Object.getPrototypeOf(v) === Object.prototype
    ) {
      return Object.fromEntries(
        Object.entries(v).map(([key, item]) => [key, visit(item, depth + 1)])
      );
    }
    return fail(path, "expected finite JSON data");
  }
  return visit(value, 0);
});
export const diagnosticSchema: Schema<C.Diagnostic> = object({
  code: enumeration(ERROR_CODES),
  message: text,
});
export const errorResponseSchema: Schema<C.ErrorResponse> = object({
  error: object({
    code: enumeration(ERROR_CODES),
    message: text,
    requestId: uuidSchema,
  }),
});
export const projectIdentitySchema: Schema<C.ProjectIdentity> = object({
  projectId: uuidSchema,
  environmentId: uuidSchema,
  localProjectId: text,
});
const base = {
  protocolVersion: literal(PROTOCOL_VERSION),
  requestId: uuidSchema,
};
const envelope = { ...base, environmentId: uuidSchema, sessionId: uuidSchema };
export const agentEnvelopeSchema: Schema<C.AgentEnvelope> = object(envelope);
const host = object({
  hostname: text,
  os: enumeration(["linux", "darwin"] as const),
});
export const enrollmentRequestSchema: Schema<C.EnrollmentRequest> = object({
  ...base,
  token: text,
});
export const enrollmentResponseSchema: Schema<C.EnrollmentResponse> = object({
  ...base,
  environmentId: uuidSchema,
  agentId: uuidSchema,
  credential: text,
});
export const sessionRequestSchema: Schema<C.SessionRequest> = object({
  ...base,
  environmentId: uuidSchema,
  agentId: uuidSchema,
  agentVersion: text,
  host,
});
export const sessionResponseSchema: Schema<C.SessionResponse> = object({
  ...envelope,
  expiresAt: timestampSchema,
});
export const acknowledgmentSchema: Schema<C.Acknowledgment> = object({
  ...envelope,
  receivedAt: timestampSchema,
});
export const processObservationSchema: Schema<C.ProcessObservation> =
  union<C.ProcessObservation>(
    object({
      state: literal("running"),
      observedAt: timestampSchema,
      identity: text,
      pid: integer(1),
    }),
    object({ state: literal("stopped"), observedAt: timestampSchema }),
    object({
      state: literal("unknown"),
      observedAt: timestampSchema,
      diagnostic: diagnosticSchema,
    })
  );
export const projectValidationSchema: Schema<C.ProjectValidation> =
  union<C.ProjectValidation>(
    object({ state: literal("valid") }),
    object({ state: literal("invalid"), diagnostic: diagnosticSchema })
  );
export const runSummarySchema: Schema<C.RunSummary> = object({
  runId: text,
  status: text,
  startedAt: timestampSchema,
  updatedAt: timestampSchema,
});
const runs = array(runSummarySchema, LIMITS.runSummariesPerProject);
export const projectObservationSchema: Schema<C.ProjectObservation> = object({
  projectId: uuidSchema,
  localProjectId: text,
  displayName: text,
  canonicalPath: refine(
    text,
    (v) => v.startsWith("/"),
    "expected Linux/macOS absolute folder"
  ),
  cliVersion: text,
  validation: projectValidationSchema,
  process: processObservationSchema,
  observedAt: timestampSchema,
  snapshot: optional(jsonValueSchema),
  snapshotObservedAt: optional(timestampSchema),
  snapshotError: optional(diagnosticSchema),
  runs,
});
const inventory = refine(
  object({
    revisionId: uuidSchema,
    pageIndex: integer(0, 99),
    pageCount: integer(1, 100),
    projects: array(projectObservationSchema, LIMITS.managedProjectsPerAgent),
  }),
  (v) =>
    v.pageIndex < v.pageCount &&
    new Set(v.projects.map((p) => p.projectId)).size === v.projects.length &&
    new Set(v.projects.map((p) => p.localProjectId)).size === v.projects.length,
  "invalid inventory page or duplicate project identity"
);
export const observationRequestSchema: Schema<C.ObservationRequest> = schema(
  (input, path) => {
    // Measure before traversal; rejects cycles/non-JSON without echoing contents.
    let encoded: string | undefined;
    try {
      encoded = JSON.stringify(input);
    } catch {
      fail(path, "body is not JSON");
    }
    if (
      encoded === undefined ||
      utf8Bytes(encoded) > LIMITS.observationBodyBytes
    )
      fail(path, "observation body exceeds limit or is missing");
    return object({
      ...envelope,
      sequence: integer(0),
      observedAt: timestampSchema,
      inventory,
    }).parse(input, path);
  }
);
/** HTTP consumers use this before parsing so whitespace also counts toward 4 MiB. */
export function parseObservationBody(body: string): C.ObservationRequest {
  if (utf8Bytes(body) > LIMITS.observationBodyBytes)
    fail("$", "observation body exceeds limit");
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    fail("$", "malformed JSON body");
  }
  return observationRequestSchema.parse(value);
}

const command = {
  commandId: uuidSchema,
  projectId: uuidSchema,
  environmentId: uuidSchema,
  localProjectId: text,
  sessionId: uuidSchema,
  operation: enumeration(["start", "stop"] as const),
  actor: literal(OPERATOR_ACTOR),
  idempotencyKey: text,
  submittedAt: timestampSchema,
  expiresAt: timestampSchema,
};
export const lifecycleCommandSchema: Schema<C.LifecycleCommand> =
  object(command);
export const commandRecordSchema: Schema<C.CommandRecord> = refine(
  object({
    ...command,
    state: enumeration(COMMAND_STATES),
    claimedAt: optional(timestampSchema),
    owner: optional(object({ agentId: uuidSchema, sessionId: uuidSchema })),
    completedAt: optional(timestampSchema),
    evidence: optional(jsonValueSchema),
    diagnostic: optional(diagnosticSchema),
    closure: optional(
      object({
        closedAt: timestampSchema,
        actor: literal(OPERATOR_ACTOR),
        reason: text,
      })
    ),
  }),
  (v) => {
    const claimed = !["accepted", "expired"].includes(v.state);
    return (
      claimed === (v.claimedAt !== undefined && v.owner !== undefined) &&
      (claimed || (v.claimedAt === undefined && v.owner === undefined)) &&
      ["succeeded", "failed"].includes(v.state) ===
        (v.completedAt !== undefined) &&
      (v.closure === undefined || v.state === "unknown")
    );
  },
  "command state contradicts claim, completion or unresolved closure"
);
export const claimRequestSchema: Schema<C.ClaimRequest> = object({
  ...envelope,
  commandId: uuidSchema,
});
export const claimResponseSchema: Schema<C.ClaimResponse> = refine(
  object({ ...envelope, command: commandRecordSchema }),
  (v) => v.environmentId === v.command.environmentId,
  "claim environment mismatch"
);
export const readSelectionSchema: Schema<C.ReadSelection> =
  union<C.ReadSelection>(
    object({
      kind: literal("runs"),
      limit: integer(1, LIMITS.runSummariesPerProject),
      cursor: optional(text),
    }),
    object({ kind: literal("run-detail"), runId: text }),
    object({
      kind: literal("log-chunk"),
      runId: text,
      stream: enumeration(LOG_STREAMS),
      cursor: optional(text),
      maxBytes: integer(1, LIMITS.logChunkBytes),
    })
  );
export const readRequestSchema: Schema<C.ReadRequest> = object({
  readId: uuidSchema,
  projectId: uuidSchema,
  localProjectId: text,
  sessionId: uuidSchema,
  submittedAt: timestampSchema,
  expiresAt: timestampSchema,
  selection: readSelectionSchema,
});
export const readPayloadSchema: Schema<C.ReadPayload> = union<C.ReadPayload>(
  object({ kind: literal("runs"), runs, nextCursor: optional(text) }),
  object({ kind: literal("run-detail"), runId: text, detail: jsonValueSchema }),
  object({
    kind: literal("log-chunk"),
    runId: text,
    stream: enumeration(LOG_STREAMS),
    text: refine(
      schema<string>((v, p) =>
        typeof v === "string" ? v : fail(p, "expected log text")
      ),
      (v) => utf8Bytes(v) <= LIMITS.logChunkBytes,
      "log exceeds byte limit"
    ),
    cursor: text,
    reset: boolean,
    eof: boolean,
  })
);
export const readResultSchema: Schema<C.ReadResult> = union<C.ReadResult>(
  object({ readId: uuidSchema, state: literal("pending") }),
  object({
    readId: uuidSchema,
    state: literal("completed"),
    completedAt: timestampSchema,
    payload: readPayloadSchema,
  }),
  object({
    readId: uuidSchema,
    state: enumeration(["expired", "unavailable"] as const),
    diagnostic: diagnosticSchema,
  })
);
export const pollRequestSchema = agentEnvelopeSchema;
export const pollResponseSchema: Schema<C.PollResponse> = refine(
  object({
    ...envelope,
    commands: array(lifecycleCommandSchema, LIMITS.activeCommandsPerAgent),
    reads: array(readRequestSchema, LIMITS.pendingReadsPerAgent),
  }),
  (v) =>
    v.commands.every(
      (c) => c.environmentId === v.environmentId && c.sessionId === v.sessionId
    ) &&
    v.reads.every((r) => r.sessionId === v.sessionId) &&
    new Set(v.commands.map((c) => c.projectId)).size === v.commands.length &&
    new Set(v.reads.map((r) => r.projectId)).size === v.reads.length,
  "poll targets another environment/session or repeats a project slot"
);
export const agentResultSchema: Schema<C.AgentResult> = union<C.AgentResult>(
  object({
    kind: literal("command"),
    commandId: uuidSchema,
    state: enumeration(["succeeded", "failed", "unknown"] as const),
    observedAt: timestampSchema,
    evidence: jsonValueSchema,
    diagnostic: optional(diagnosticSchema),
  }),
  object({
    kind: literal("read"),
    result: refine(
      readResultSchema,
      (v) => v.state !== "pending",
      "cannot publish pending read"
    ),
  }) as Schema<C.AgentResult>
);
export const resultRequestSchema: Schema<C.ResultRequest> = object({
  ...envelope,
  result: agentResultSchema,
});

export const createEnvironmentRequestSchema: Schema<C.CreateEnvironmentRequest> =
  object({ name: text });
export const enrollmentTokenResponseSchema: Schema<C.EnrollmentTokenResponse> =
  object({
    environmentId: uuidSchema,
    token: text,
    expiresAt: timestampSchema,
  });
export const environmentRecordSchema: Schema<C.EnvironmentRecord> = refine(
  object({
    environmentId: uuidSchema,
    name: text,
    enrollment: enumeration(["pending", "enrolled", "revoked"] as const),
    connection: enumeration(["awaiting-signal", "online", "offline"] as const),
    lastContactAt: optional(timestampSchema),
    agentVersion: optional(text),
    host: optional(host),
  }),
  (v) =>
    v.connection !== "online" ||
    (v.enrollment === "enrolled" && v.lastContactAt !== undefined),
  "online requires enrolled agent and authenticated contact"
);
export const submitCommandRequestSchema: Schema<C.SubmitCommandRequest> =
  object({ operation: command.operation });
export const submitCommandResponseSchema: Schema<C.SubmitCommandResponse> =
  object({ commandId: uuidSchema, state: literal("accepted") });
export const closeUnresolvedRequestSchema: Schema<C.CloseUnresolvedRequest> =
  object({ acknowledged: literal(true), reason: text });
const paging = {
  limit: integer(1, LIMITS.maximumPageSize),
  cursor: optional(text),
};
export const pageRequestSchema: Schema<C.PageRequest> = object(paging);
export const projectFilterSchema: Schema<C.ProjectFilter> = object({
  ...paging,
  environmentId: optional(uuidSchema),
  process: optional(enumeration(["running", "stopped", "unknown"] as const)),
  connection: optional(enumeration(["online", "offline"] as const)),
});
export const aggregateProjectSchema: Schema<C.AggregateProject> = refine(
  object({
    projectId: uuidSchema,
    environmentId: uuidSchema,
    localProjectId: text,
    managed: boolean,
    connection: enumeration(["online", "offline"] as const),
    lastReceivedAt: timestampSchema,
    observation: projectObservationSchema,
  }),
  (v) =>
    v.projectId === v.observation.projectId &&
    v.localProjectId === v.observation.localProjectId,
  "aggregate and observation identity mismatch"
);
export function pageSchema<T>(item: Schema<T>): Schema<C.Page<T>> {
  return object({
    items: array(item, LIMITS.maximumPageSize),
    nextCursor: optional(text),
  });
}
