import {
  DEFAULT_WORKFLOW_LIFECYCLE,
  type WorkflowLifecycleConfig,
} from "./lifecycle.js";

export type WorkflowHooksConfig = {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  beforeRemove: string | null;
  timeoutMs: number;
};

export type WorkflowTrackerConfig = {
  kind: string | null;
  endpoint: string | null;
  apiKey: string | null;
  projectSlug: string | null;
  activeStates: string[];
  terminalStates: string[];
  projectId: string | null;
  stateFieldName: string;
  blockerCheckStates: string[];
};

export type WorkflowWorkspaceConfig = {
  root: string | null;
};

export type WorkflowAgentConfig = {
  maxConcurrentAgents: number;
  maxRetryBackoffMs: number;
  maxConcurrentAgentsByState: Record<string, number>;
  maxTurns: number;
  retryBaseDelayMs: number;
};

export type RetryPolicyOptions = {
  baseDelayMs?: number;
  maxDelayMs?: number;
};

export type WorkflowCodexConfig = {
  command: string;
  approvalPolicy: string | null;
  threadSandbox: string | null;
  turnSandboxPolicy: string | null;
  turnTimeoutMs: number;
  readTimeoutMs: number;
  stallTimeoutMs: number;
};

export type WorkflowSourceFormat =
  | "front-matter"
  | "legacy-sectioned"
  | "default";

export type WorkflowDefinition = {
  promptTemplate: string;
  tracker: WorkflowTrackerConfig;
  polling: {
    intervalMs: number;
  };
  workspace: WorkflowWorkspaceConfig;
  hooks: WorkflowHooksConfig;
  agent: WorkflowAgentConfig;
  codex: WorkflowCodexConfig;
  lifecycle: WorkflowLifecycleConfig;
  format: WorkflowSourceFormat;
};

export type ParsedWorkflow = WorkflowDefinition & {
  githubProjectId: string | null;
  agentCommand: string;
  hookPath: string | null;
  maxConcurrentByState: Record<string, number>;
};

export const DEFAULT_CODEX_COMMAND = "codex app-server";
export const DEFAULT_AGENT_COMMAND = DEFAULT_CODEX_COMMAND;
export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;
export const DEFAULT_POLL_INTERVAL_MS = 30_000;
export const DEFAULT_MAX_RETRY_BACKOFF_MS = 300_000;
export const DEFAULT_MAX_DELAY_MS = DEFAULT_MAX_RETRY_BACKOFF_MS;
export const DEFAULT_BASE_DELAY_MS = 10_000;
export const DEFAULT_MAX_TURNS = 20;
export const DEFAULT_READ_TIMEOUT_MS = 5_000;
export const DEFAULT_TURN_TIMEOUT_MS = 3_600_000;
export const DEFAULT_STALL_TIMEOUT_MS = 300_000;
export const DEFAULT_MAX_CONCURRENT_AGENTS = 10;

export const DEFAULT_WORKFLOW_HOOKS: WorkflowHooksConfig = {
  afterCreate: null,
  beforeRun: null,
  afterRun: null,
  beforeRemove: null,
  timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
};

export const DEFAULT_WORKFLOW_TRACKER: WorkflowTrackerConfig = {
  kind: null,
  endpoint: null,
  apiKey: null,
  projectSlug: null,
  activeStates: DEFAULT_WORKFLOW_LIFECYCLE.activeStates,
  terminalStates: DEFAULT_WORKFLOW_LIFECYCLE.terminalStates,
  projectId: null,
  stateFieldName: DEFAULT_WORKFLOW_LIFECYCLE.stateFieldName,
  blockerCheckStates: DEFAULT_WORKFLOW_LIFECYCLE.blockerCheckStates,
};

export const DEFAULT_WORKFLOW_WORKSPACE: WorkflowWorkspaceConfig = {
  root: null,
};

export const DEFAULT_WORKFLOW_AGENT: WorkflowAgentConfig = {
  maxConcurrentAgents: DEFAULT_MAX_CONCURRENT_AGENTS,
  maxRetryBackoffMs: DEFAULT_MAX_RETRY_BACKOFF_MS,
  maxConcurrentAgentsByState: {},
  maxTurns: DEFAULT_MAX_TURNS,
  retryBaseDelayMs: DEFAULT_BASE_DELAY_MS,
};

export const DEFAULT_WORKFLOW_CODEX: WorkflowCodexConfig = {
  command: DEFAULT_CODEX_COMMAND,
  approvalPolicy: null,
  threadSandbox: null,
  turnSandboxPolicy: null,
  turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS,
  readTimeoutMs: DEFAULT_READ_TIMEOUT_MS,
  stallTimeoutMs: DEFAULT_STALL_TIMEOUT_MS,
};

export const DEFAULT_WORKFLOW_DEFINITION: ParsedWorkflow = {
  promptTemplate: "",
  tracker: DEFAULT_WORKFLOW_TRACKER,
  polling: {
    intervalMs: DEFAULT_POLL_INTERVAL_MS,
  },
  workspace: DEFAULT_WORKFLOW_WORKSPACE,
  hooks: DEFAULT_WORKFLOW_HOOKS,
  agent: DEFAULT_WORKFLOW_AGENT,
  codex: DEFAULT_WORKFLOW_CODEX,
  lifecycle: DEFAULT_WORKFLOW_LIFECYCLE,
  format: "default",
  githubProjectId: null,
  agentCommand: DEFAULT_CODEX_COMMAND,
  hookPath: null,
  maxConcurrentByState: {},
};
