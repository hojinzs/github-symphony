export type RuntimeSessionSnapshot = {
  runId: string;
  workspaceId: string;
  issueIdentifier: string;
  phase: string;
  attempt: number;
  retryKind: string;
  sessionId: string;
  threadId: string;
  status: "active" | "completed" | "failed";
  startedAt: string;
  updatedAt: string;
  exitClassification: string | null;
};
