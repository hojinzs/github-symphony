import type { RepositoryRef } from "../domain/workspace.js";
import type {
  OrchestratorRunRecord,
  OrchestratorProjectConfig,
} from "./status-surface.js";
import type { WorkflowLifecycleConfig } from "../workflow/lifecycle.js";

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

export type TrackerAdapterKind = "github-project" | (string & {});

export type TrackerBindingSummary = {
  adapter: TrackerAdapterKind;
  bindingId: string;
};

export type BlockerRef = {
  id: string | null;
  identifier: string | null;
  state: string | null;
};

export type TrackedIssueContentType = "Issue" | "PullRequest";

export type TrackedPullRequestContext = {
  id: string;
  number: number;
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
  contentType?: TrackedIssueContentType;
  /** Source-provider state, distinct from the workflow/project state. */
  sourceState?: string | null;
  linkedPullRequests?: TrackedPullRequestContext[];
  pullRequest?: TrackedPullRequestContext;
  [key: string]: unknown;
};

export type TrackedIssue = {
  id: string;
  identifier: string;
  number: number;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  labels: string[];
  blockedBy: BlockerRef[];
  createdAt: string | null;
  updatedAt: string | null;
  repository: RepositoryRef & {
    url?: string;
  };
  tracker: TrackerBindingSummary & {
    itemId: string;
  };
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
      /** Agent-authored body to publish after a confirmed readback. */
      commentBody?: string;
    };

export type TrackerCommentWriteResult = {
  outcome: "created" | "unchanged";
  rateLimits: Record<string, unknown> | null;
};

export type TrackerIssueCommentUpsertResult = {
  outcome: "created" | "updated" | "unchanged";
  rateLimits: Record<string, unknown> | null;
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
};

export type OrchestratorTrackerAdapter = {
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
  requestState?(
    project: OrchestratorProjectConfig,
    input: {
      issueSubjectId: string;
      itemId: string;
      request: TrackerStateRequest;
    },
    dependencies?: OrchestratorTrackerDependencies
  ): Promise<TrackerStateResult>;
  upsertTransitionComment?(
    project: OrchestratorProjectConfig,
    input: {
      issueSubjectId: string;
      body: string;
    },
    dependencies?: OrchestratorTrackerDependencies
  ): Promise<TrackerCommentWriteResult>;
  upsertIssueComment?(
    project: OrchestratorProjectConfig,
    issue: TrackedIssue,
    input: {
      marker: string;
      body: string;
    },
    dependencies?: OrchestratorTrackerDependencies
  ): Promise<TrackerIssueCommentUpsertResult>;
};
