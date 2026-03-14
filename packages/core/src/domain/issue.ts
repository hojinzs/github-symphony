import type { TrackerAdapterKind } from "../contracts/tracker-adapter.js";

/**
 * Canonical issue subject identity — the durable key that ties workspace
 * lifecycle, execution history, and orchestration records together.
 *
 * Derived from the issue subject (e.g. GitHub Issue), NOT from tracker
 * placement (e.g. GitHub Project item). Project item IDs are placement
 * metadata and do not participate in workspace identity derivation.
 */
export type IssueSubjectIdentity = {
  projectId: string;
  adapter: TrackerAdapterKind;
  /**
   * Stable subject identifier within the adapter scope.
   * For GitHub: the issue node ID (not the project item ID).
   * Must remain stable across project transfers and re-placement.
   */
  issueSubjectId: string;
};

/**
 * Issue workspace lifecycle status.
 *
 * - `active`          — available for runs
 * - `cleanup_pending` — terminal state reached, cleanup scheduled
 * - `cleanup_blocked` — `before_remove` hook failed, operator action needed
 * - `removed`         — workspace cleaned up
 */
export type IssueWorkspaceStatus =
  | "active"
  | "cleanup_pending"
  | "cleanup_blocked"
  | "removed";

export type IssueWorkspaceRecord = {
  workspaceKey: string;
  projectId: string;
  adapter: TrackerAdapterKind;
  issueSubjectId: string;
  issueIdentifier: string;
  workspacePath: string;
  repositoryPath: string;
  status: IssueWorkspaceStatus;
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
};
