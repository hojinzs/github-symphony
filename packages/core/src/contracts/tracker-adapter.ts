import type { WorkflowExecutionPhase } from "../workflow/lifecycle.js";
import type { RepositoryRef } from "../domain/workspace.js";
import type {
  OrchestratorRunRecord,
  OrchestratorWorkspaceConfig,
} from "./status-surface.js";

export type TrackerAdapterKind = "github-project" | (string & {});

export type TrackerBindingSummary = {
  adapter: TrackerAdapterKind;
  bindingId: string;
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
  blockedBy: string[];
  createdAt: string | null;
  updatedAt: string | null;
  repository: RepositoryRef & {
    url?: string;
  };
  tracker: TrackerBindingSummary & {
    itemId: string;
  };
  phase: WorkflowExecutionPhase;
  metadata: Record<string, string>;
};

export type OrchestratorTrackerAdapter = {
  listIssues(
    workspace: OrchestratorWorkspaceConfig,
    dependencies?: {
      fetchImpl?: typeof fetch;
      token?: string;
    }
  ): Promise<TrackedIssue[]>;
  buildWorkerEnvironment(
    workspace: OrchestratorWorkspaceConfig,
    issue: TrackedIssue
  ): Record<string, string>;
  reviveIssue(
    workspace: OrchestratorWorkspaceConfig,
    run: OrchestratorRunRecord
  ): TrackedIssue;
};
