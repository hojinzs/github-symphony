export const ISSUE_ORCHESTRATION_STATES = [
  "unclaimed",
  "claimed",
  "running",
  "retry_queued",
  "released",
] as const;

export type IssueOrchestrationState =
  (typeof ISSUE_ORCHESTRATION_STATES)[number];

export type IssueRetryEntry = {
  attempt: number;
  dueAt: string;
  error: string | null;
};

export type IssueOrchestrationRecord = {
  issueId: string;
  identifier: string;
  workspaceKey: string;
  completedOnce: boolean;
  state: IssueOrchestrationState;
  currentRunId: string | null;
  retryEntry: IssueRetryEntry | null;
  updatedAt: string;
};
