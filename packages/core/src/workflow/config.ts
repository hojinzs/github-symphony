import { DEFAULT_WORKFLOW_LIFECYCLE, type WorkflowLifecycleConfig } from "./lifecycle.js";

export type WorkflowHooksConfig = {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  beforeRemove: string | null;
};

export type WorkflowRuntimeConfig = {
  agentCommand: string;
  hooks: WorkflowHooksConfig;
};

export type WorkflowSchedulerConfig = {
  pollIntervalMs: number;
};

export type RetryPolicyOptions = {
  baseDelayMs?: number;
  maxDelayMs?: number;
};

export type WorkflowRetryConfig = {
  baseDelayMs: number;
  maxDelayMs: number;
};

export type WorkflowSourceFormat = "front-matter" | "legacy-sectioned" | "default";

export type WorkflowDefinition = {
  githubProjectId: string | null;
  promptTemplate: string;
  promptGuidelines: string;
  allowedRepositories: string[];
  runtime: WorkflowRuntimeConfig;
  scheduler: WorkflowSchedulerConfig;
  retry: WorkflowRetryConfig;
  lifecycle: WorkflowLifecycleConfig;
  format: WorkflowSourceFormat;
};

export type ParsedWorkflow = WorkflowDefinition & {
  agentCommand: string;
  hookPath: string;
};

export const DEFAULT_AGENT_COMMAND = "bash -lc codex app-server";
export const DEFAULT_HOOK_PATH = "hooks/after_create.sh";
export const DEFAULT_POLL_INTERVAL_MS = 30_000;
export const DEFAULT_BASE_DELAY_MS = 1_000;
export const DEFAULT_MAX_DELAY_MS = 30_000;

export const DEFAULT_WORKFLOW_HOOKS: WorkflowHooksConfig = {
  afterCreate: DEFAULT_HOOK_PATH,
  beforeRun: null,
  afterRun: null,
  beforeRemove: null
};

export const DEFAULT_WORKFLOW_RUNTIME: WorkflowRuntimeConfig = {
  agentCommand: DEFAULT_AGENT_COMMAND,
  hooks: DEFAULT_WORKFLOW_HOOKS
};

export const DEFAULT_WORKFLOW_SCHEDULER: WorkflowSchedulerConfig = {
  pollIntervalMs: DEFAULT_POLL_INTERVAL_MS
};

export const DEFAULT_WORKFLOW_RETRY: WorkflowRetryConfig = {
  baseDelayMs: DEFAULT_BASE_DELAY_MS,
  maxDelayMs: DEFAULT_MAX_DELAY_MS
};

export const DEFAULT_WORKFLOW_DEFINITION: ParsedWorkflow = {
  githubProjectId: null,
  promptTemplate: "",
  promptGuidelines: "",
  allowedRepositories: [],
  runtime: DEFAULT_WORKFLOW_RUNTIME,
  scheduler: DEFAULT_WORKFLOW_SCHEDULER,
  retry: DEFAULT_WORKFLOW_RETRY,
  lifecycle: DEFAULT_WORKFLOW_LIFECYCLE,
  format: "default",
  agentCommand: DEFAULT_AGENT_COMMAND,
  hookPath: DEFAULT_HOOK_PATH
};
