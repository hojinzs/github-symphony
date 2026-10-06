import type {
  COMMAND_STATES,
  ErrorCode,
  LOG_STREAMS,
  READ_STATES,
} from "./constants.js";

/** Validated as opaque UUIDs at the wire boundary. Local IDs are not UUIDs. */
export type UUID = string;
export type UtcTimestamp = string;
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type CommandState = (typeof COMMAND_STATES)[number];
export type ReadState = (typeof READ_STATES)[number];
export type LogStream = (typeof LOG_STREAMS)[number];
export type LifecycleOperation = "start" | "stop";

export interface ErrorResponse {
  error: { code: ErrorCode; message: string; requestId: UUID };
}
export interface ProjectIdentity {
  projectId: UUID;
  environmentId: UUID;
  localProjectId: string;
}
export interface AgentEnvelope {
  protocolVersion: 1;
  environmentId: UUID;
  sessionId: UUID;
  requestId: UUID;
}
export interface Diagnostic {
  code: ErrorCode;
  message: string;
}
export type ProcessObservation =
  | {
      state: "running";
      observedAt: UtcTimestamp;
      identity: string;
      pid: number;
    }
  | { state: "stopped"; observedAt: UtcTimestamp }
  | { state: "unknown"; observedAt: UtcTimestamp; diagnostic: Diagnostic };
export type ProjectValidation =
  | { state: "valid" }
  | { state: "invalid"; diagnostic: Diagnostic };
export interface RunSummary {
  runId: string;
  status: string;
  startedAt: UtcTimestamp;
  updatedAt: UtcTimestamp;
}
export interface ProjectObservation {
  projectId: UUID;
  localProjectId: string;
  displayName: string;
  canonicalPath: string;
  cliVersion: string;
  validation: ProjectValidation;
  process: ProcessObservation;
  observedAt: UtcTimestamp;
  snapshot?: JsonValue;
  snapshotObservedAt?: UtcTimestamp;
  snapshotError?: Diagnostic;
  runs: RunSummary[];
}
/** Complete revision commits only after every page arrives; pages may update status earlier. */
export interface ObservationRequest extends AgentEnvelope {
  sequence: number;
  observedAt: UtcTimestamp;
  inventory: {
    revisionId: UUID;
    pageIndex: number;
    pageCount: number;
    projects: ProjectObservation[];
  };
}
export interface EnrollmentRequest {
  protocolVersion: 1;
  requestId: UUID;
  token: string;
}
export interface EnrollmentResponse {
  protocolVersion: 1;
  requestId: UUID;
  environmentId: UUID;
  agentId: UUID;
  credential: string;
}
export interface SessionRequest {
  protocolVersion: 1;
  requestId: UUID;
  environmentId: UUID;
  agentId: UUID;
  agentVersion: string;
  host: { hostname: string; os: "linux" | "darwin" };
}
export interface SessionResponse extends AgentEnvelope {
  expiresAt: UtcTimestamp;
}
export interface Acknowledgment extends AgentEnvelope {
  receivedAt: UtcTimestamp;
}
export interface LifecycleCommand {
  commandId: UUID;
  projectId: UUID;
  environmentId: UUID;
  localProjectId: string;
  sessionId: UUID;
  operation: LifecycleOperation;
  actor: "local-owner";
  idempotencyKey: string;
  submittedAt: UtcTimestamp;
  expiresAt: UtcTimestamp;
}
export interface CommandRecord extends LifecycleCommand {
  state: CommandState;
  claimedAt?: UtcTimestamp;
  owner?: { agentId: UUID; sessionId: UUID };
  completedAt?: UtcTimestamp;
  evidence?: JsonValue;
  diagnostic?: Diagnostic;
  /** Unknown remains unknown after explicit closure. */
  closure?: { closedAt: UtcTimestamp; actor: "local-owner"; reason: string };
}
export interface ClaimRequest extends AgentEnvelope {
  commandId: UUID;
}
/** Replay preserves original ownership/time; never implies permission to repeat effects. */
export interface ClaimResponse extends AgentEnvelope {
  command: CommandRecord;
}
export type ReadSelection =
  | { kind: "runs"; limit: number; cursor?: string }
  | { kind: "run-detail"; runId: string }
  | {
      kind: "log-chunk";
      runId: string;
      stream: LogStream;
      cursor?: string;
      maxBytes: number;
    };
export interface ReadRequest {
  readId: UUID;
  projectId: UUID;
  localProjectId: string;
  sessionId: UUID;
  submittedAt: UtcTimestamp;
  expiresAt: UtcTimestamp;
  selection: ReadSelection;
}
export type ReadPayload =
  | { kind: "runs"; runs: RunSummary[]; nextCursor?: string }
  | { kind: "run-detail"; runId: string; detail: JsonValue }
  | {
      kind: "log-chunk";
      runId: string;
      stream: LogStream;
      text: string;
      cursor: string;
      reset: boolean;
      eof: boolean;
    };
export type ReadResult =
  | { readId: UUID; state: "pending" }
  | {
      readId: UUID;
      state: "completed";
      completedAt: UtcTimestamp;
      payload: ReadPayload;
    }
  | { readId: UUID; state: "expired" | "unavailable"; diagnostic: Diagnostic };
export type PollRequest = AgentEnvelope;
export interface PollResponse extends AgentEnvelope {
  commands: LifecycleCommand[];
  reads: ReadRequest[];
}
export type AgentResult =
  | {
      kind: "command";
      commandId: UUID;
      state: "succeeded" | "failed" | "unknown";
      observedAt: UtcTimestamp;
      evidence: JsonValue;
      diagnostic?: Diagnostic;
    }
  | { kind: "read"; result: Exclude<ReadResult, { state: "pending" }> };
export interface ResultRequest extends AgentEnvelope {
  result: AgentResult;
}

/** Authentication/session fencing, storage and side effects belong to consumers. */
export interface AgentControlPlaneClient {
  enroll(request: EnrollmentRequest): Promise<EnrollmentResponse>;
  openSession(request: SessionRequest): Promise<SessionResponse>;
  observe(request: ObservationRequest): Promise<Acknowledgment>;
  poll(request: PollRequest): Promise<PollResponse>;
  claim(request: ClaimRequest): Promise<ClaimResponse>;
  publishResult(request: ResultRequest): Promise<Acknowledgment>;
}

export interface CreateEnvironmentRequest {
  name: string;
}
export interface EnrollmentTokenResponse {
  environmentId: UUID;
  token: string;
  expiresAt: UtcTimestamp;
}
export interface EnvironmentRecord {
  environmentId: UUID;
  name: string;
  enrollment: "pending" | "enrolled" | "revoked";
  connection: "awaiting-signal" | "online" | "offline";
  lastContactAt?: UtcTimestamp;
  agentVersion?: string;
  host?: { hostname: string; os: "linux" | "darwin" };
}
export interface SubmitCommandRequest {
  operation: LifecycleOperation;
}
/** Idempotency-Key is an HTTP header; actor is resolved by the service. */
export interface SubmitCommandResponse {
  commandId: UUID;
  state: "accepted";
}
export interface CloseUnresolvedRequest {
  acknowledged: true;
  reason: string;
}
export interface PageRequest {
  limit: number;
  cursor?: string;
}
export interface ProjectFilter extends PageRequest {
  environmentId?: UUID;
  process?: "running" | "stopped" | "unknown";
  connection?: "online" | "offline";
}
export interface AggregateProject extends ProjectIdentity {
  managed: boolean;
  connection: "online" | "offline";
  lastReceivedAt: UtcTimestamp;
  observation: ProjectObservation;
}
export interface Page<T> {
  items: T[];
  nextCursor?: string;
}
export interface OperatorManagementClient {
  createEnvironment(
    request: CreateEnvironmentRequest
  ): Promise<EnrollmentTokenResponse>;
  listEnvironments(): Promise<EnvironmentRecord[]>;
  regenerateEnrollment(environmentId: UUID): Promise<EnrollmentTokenResponse>;
  revoke(environmentId: UUID): Promise<void>;
  listProjects(request: ProjectFilter): Promise<Page<AggregateProject>>;
  getProject(projectId: UUID): Promise<AggregateProject>;
  submitCommand(
    projectId: UUID,
    idempotencyKey: string,
    request: SubmitCommandRequest
  ): Promise<SubmitCommandResponse>;
  getCommand(commandId: UUID): Promise<CommandRecord>;
  closeUnresolved(
    commandId: UUID,
    request: CloseUnresolvedRequest
  ): Promise<CommandRecord>;
  listCommands(
    projectId: UUID,
    request: PageRequest
  ): Promise<Page<CommandRecord>>;
  submitRead(
    projectId: UUID,
    request: ReadSelection
  ): Promise<SubmitReadResponse>;
  getRead(readId: UUID): Promise<ReadResult>;
}

export interface SubmitReadResponse {
  readId: UUID;
}
