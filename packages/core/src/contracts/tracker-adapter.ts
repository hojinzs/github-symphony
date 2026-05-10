import type { RepositoryRef } from "../domain/workspace.js";
import type {
  OrchestratorRunRecord,
  OrchestratorProjectConfig,
} from "./status-surface.js";

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
  [key: string]: unknown;
};

export type TrackedIssueMetadata = {
  contentType?: TrackedIssueContentType;
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

export type ProjectItemsCache = {
  getOrLoad(
    key: string,
    load: () => Promise<TrackedIssue[]>
  ): Promise<TrackedIssue[]>;
};

export type OrchestratorTrackerDependencies = {
  fetchImpl?: typeof fetch;
  token?: string;
  projectItemsCache?: ProjectItemsCache;
};

export type OrchestratorTrackerAdapter = {
  listIssues(
    project: OrchestratorProjectConfig,
    dependencies?: OrchestratorTrackerDependencies
  ): Promise<TrackedIssue[]>;
  listIssuesByStates(
    project: OrchestratorProjectConfig,
    states: readonly string[],
    dependencies?: OrchestratorTrackerDependencies
  ): Promise<TrackedIssue[]>;
  fetchIssueStatesByIds(
    project: OrchestratorProjectConfig,
    issueIds: readonly string[],
    dependencies?: OrchestratorTrackerDependencies
  ): Promise<TrackedIssue[]>;
  buildWorkerEnvironment(
    project: OrchestratorProjectConfig,
    issue: TrackedIssue
  ): Record<string, string>;
  reviveIssue(
    project: OrchestratorProjectConfig,
    run: OrchestratorRunRecord
  ): TrackedIssue;
};
