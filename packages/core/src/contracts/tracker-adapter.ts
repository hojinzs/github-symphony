import type { RepositoryRef } from "../domain/workspace.js";
import type {
  OrchestratorRunRecord,
  OrchestratorProjectConfig,
} from "./status-surface.js";
import type { WorkflowLifecycleConfig } from "../workflow/lifecycle.js";
import type { WorkflowTrackerConfig } from "../workflow/config.js";
import type { WorkflowValidationError } from "../workflow/parser.js";

export class TrackerRateLimitError extends Error {
  readonly name: string = "TrackerRateLimitError";

  constructor(
    message: string,
    readonly rateLimits: Record<string, unknown> | null,
    readonly retryAt: string | null
  ) {
    super(message);
  }
}

/**
 * A tracker adapter detected a permanent, provider-specific dispatch
 * constraint. The orchestrator uses this shared classification to avoid
 * retrying a run that cannot succeed without a tracker-side change.
 */
export class NonRetryableTrackerAdapterError extends Error {
  readonly name = "NonRetryableTrackerAdapterError";
}

export type TrackerAdapterKind = "github-project" | (string & {});

/** JSON-schema subset advertised to an agent runtime for a host-side tool. */
export type AgentToolInputSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: boolean;
};

/**
 * Provider-owned description of a tool that an agent may call. Credentials,
 * transport details, and provider configuration deliberately remain host-side.
 */
export type AgentToolSpec = {
  name: string;
  description: string;
  inputSchema: AgentToolInputSchema;
};

/**
 * Normalized issue identity supplied to host-side tool execution. Native
 * references are opaque to orchestration, but available to the owning adapter.
 */
export type AgentToolExecutionContext = {
  issue: {
    id: string;
    identifier: string;
    nativeRef: TrackedIssue["nativeRef"];
  };
  /**
   * Resolved host configuration for this invocation. This is never included
   * in the tool schema, child process environment, or tool result.
   */
  environment?: Record<string, string | undefined>;
};

export type TrackerBindingSummary = {
  adapter: TrackerAdapterKind;
  bindingId: string;
};

/** JSON-safe, non-secret provider reference data. The orchestrator treats it as opaque. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type BlockerRef = {
  id: string | null;
  identifier: string | null;
  state: string | null;
};

export type TrackedIssueContentType = "Issue" | "PullRequest";

export type TrackedPullRequestContext = {
  id: string;
  number?: number;
  identifier: string;
  url: string | null;
  /**
   * Pull request state from the tracker source when available
   * (for example, GitHub GraphQL states such as OPEN, CLOSED, or MERGED).
   */
  state: string | null;
  /**
   * Workflow/project state for the pull request item, when distinct from the
   * pull request's source state.
   */
  projectState?: string | null;
  isDraft?: boolean | null;
  merged?: boolean | null;
  headRefName?: string | null;
  baseRefName?: string | null;
  repository?: {
    owner: string;
    name: string;
    url: string;
    cloneUrl: string;
  };
  headRepository?: {
    owner: string;
    name: string;
    url: string;
    cloneUrl: string;
  } | null;
  [key: string]: unknown;
};

export type TrackedIssueMetadata = {
  /** @deprecated Provider payload belongs in nativeRef and adapter hooks. */
  contentType?: TrackedIssueContentType;
  /** @deprecated Provider payload belongs in nativeRef and adapter hooks. */
  sourceState?: string | null;
  /** @deprecated Provider payload belongs in nativeRef and adapter hooks. */
  linkedPullRequests?: TrackedPullRequestContext[];
  /** @deprecated Provider payload belongs in nativeRef and adapter hooks. */
  pullRequest?: TrackedPullRequestContext;
  [key: string]: unknown;
};

export type TrackedIssue = {
  id: string;
  identifier: string;
  number?: number;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  labels: string[];
  /** Whether this issue may enter the orchestration dispatch lifecycle. */
  dispatchable: boolean;
  /**
   * Provider-native identity of the first current assignee, when exposed.
   * Values are tracker-specific and must not be compared across providers.
   */
  assigneeId: string | null;
  /** Optional provider explanation for why the issue cannot be dispatched. */
  dispatchReason?: string | null;
  blockedBy: BlockerRef[];
  createdAt: string | null;
  updatedAt: string | null;
  repository: RepositoryRef & {
    url?: string;
  };
  tracker: TrackerBindingSummary & {
    /** @deprecated Kept only for third-party adapter source compatibility. */
    itemId?: string;
  };
  /** Opaque, non-secret provider identity data; only the adapter may inspect it. */
  nativeRef?: Record<string, JsonValue> | null;
  /** Provider-independent subject classification supplied by the adapter. */
  contentType?: TrackedIssueContentType;
  /** Adapter-resolved linked pull-request context for policy and prompts. */
  linkedPullRequests?: TrackedPullRequestContext[];
  /** Adapter-resolved pull-request context when the tracked item is a PR. */
  pullRequest?: TrackedPullRequestContext;
  /** Provider-independent lifecycle fact for Project/archive-like records. */
  isArchived?: boolean;
  metadata: TrackedIssueMetadata;
  rateLimits?: Record<string, unknown> | null;
};

export type TrackedIssueList = TrackedIssue[] & {
  rateLimits?: Record<string, unknown> | null;
  skippedItems?: Array<{
    id: string;
    identifier: string;
    reason: string;
  }>;
};

export type ProjectItemsCache = {
  getOrLoad(
    key: string,
    load: () => Promise<TrackedIssue[]>
  ): Promise<TrackedIssue[]>;
};

export type IssueCommentCacheEntry = {
  commentId: number;
  etag: string | null;
  body: string;
};

export type IssueCommentCache = {
  get(key: string): Promise<IssueCommentCacheEntry | null>;
  set(key: string, entry: IssueCommentCacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
};

export type OrchestratorTrackerDependencies = {
  fetchImpl?: typeof fetch;
  token?: string;
  projectItemsCache?: ProjectItemsCache;
  issueCommentCache?: IssueCommentCache;
  assignedOnly?: boolean;
  workflowLifecycle?: WorkflowLifecycleConfig;
  workflowTracker?: Pick<
    WorkflowTrackerConfig,
    "blockerCheckStates" | "terminalStates"
  >;
};

export type TrackerStateRequest =
  | {
      type: "state-read";
    }
  | {
      type: "transition-request";
      expectedState: string;
      targetState: string;
      reason: string;
    };

export type TrackerStateResult = {
  ok: boolean;
  outcome: "confirmed" | "expected_state_mismatch" | "rejected" | "failed";
  state: string | null;
  expectedState: string | null;
  targetState: string | null;
  reason: string | null;
  rateLimits: Record<string, unknown> | null;
  error: string | null;
  /**
   * State-read only: routability calculated from a freshly normalized tracker
   * snapshot. `null` means that no routability decision was available.
   */
  routable?: boolean | null;
  /** State-read only: concrete reason when the refreshed issue is unroutable. */
  routableReason?: string | null;
};

export type TrackerTerminalFact = {
  kind: string;
  reason: string;
  relatedIdentifier: string | null;
};

export type OrchestratorTrackerAdapter = {
  /**
   * Validates configuration owned by this tracker provider. Optional while
   * adapter packages migrate to the provider-config contract.
   */
  validateProviderConfig?: (
    provider: Record<string, unknown>,
    context?: { rawProvider: Record<string, unknown> }
  ) => WorkflowValidationError[];
  /** Supplies lifecycle defaults when a workflow intentionally omits them. */
  defaultLifecycle?: () => WorkflowLifecycleConfig;
  /** Names whose values authenticate this tracker and must not reach agents. */
  secretEnvironmentNames(): string[];
  /**
   * Resolves tracker credentials for the worker host boundary. Project-scoped
   * values take precedence over daemon values, and adapters may require a
   * complete credential set (for example a broker URL/secret pair). Adapters
   * backed by external trackers should implement this hook so missing
   * credentials produce an observable dispatch warning.
   */
  resolveWorkerCredentials?(
    project: OrchestratorProjectConfig,
    environments: {
      project: Readonly<Record<string, string>>;
      daemon: Readonly<NodeJS.ProcessEnv>;
    }
  ): Record<string, string>;
  /** Advertises provider tools that the runtime may expose to the agent. */
  agentToolSpecs?(): readonly AgentToolSpec[];
  /** Executes one advertised provider tool on the host for the active issue. */
  executeAgentTool?(
    name: string,
    args: Record<string, unknown>,
    context: AgentToolExecutionContext
  ): Promise<unknown>;
  listIssues(
    project: OrchestratorProjectConfig,
    dependencies?: OrchestratorTrackerDependencies
  ): Promise<TrackedIssueList>;
  listIssuesByStates(
    project: OrchestratorProjectConfig,
    states: readonly string[],
    dependencies?: OrchestratorTrackerDependencies
  ): Promise<TrackedIssueList>;
  fetchIssueStatesByIds(
    project: OrchestratorProjectConfig,
    issueIds: readonly string[],
    dependencies?: OrchestratorTrackerDependencies
  ): Promise<TrackedIssueList>;
  buildWorkerEnvironment(
    project: OrchestratorProjectConfig,
    issue: TrackedIssue
  ): Record<string, string>;
  reviveIssue(
    project: OrchestratorProjectConfig,
    run: OrchestratorRunRecord
  ): TrackedIssue;
  /** Resolve provider-specific issue/PR cards to their dispatchable subjects. */
  resolveCanonicalIssues?(issues: readonly TrackedIssue[]): TrackedIssue[];
  /** Match a provider-specific alias (such as a linked pull request) to a subject. */
  matchesIssueIdentifier?(issue: TrackedIssue, identifier: string): boolean;
  /** Return the provider project-item identity used for state mutations. */
  getTrackerItemId?(issue: TrackedIssue): string | null;
  /** Resolve an adapter-owned checkout branch for a canonical issue or PR card. */
  resolveBranchCheckoutTarget?(
    issue: TrackedIssue
  ): { headRefName: string } | null;
  /** Return tracker-owned branch evidence for dirty-workspace attribution. */
  resolveAttributableBranches?(issue: TrackedIssue): string[];
  /** Provider-specific structured event fields that are safe to expose. */
  buildStructuredEventMetadata?(
    project: OrchestratorProjectConfig,
    issue: TrackedIssue
  ): Record<string, unknown>;
  resolveTerminalFact?(issue: TrackedIssue): TrackerTerminalFact | null;
  requestState?(
    project: OrchestratorProjectConfig,
    input: {
      issueSubjectId: string;
      itemId: string;
      request: TrackerStateRequest;
    },
    dependencies?: OrchestratorTrackerDependencies
  ): Promise<TrackerStateResult>;
};
