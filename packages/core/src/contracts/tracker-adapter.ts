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
  metadata: Record<string, string>;
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
