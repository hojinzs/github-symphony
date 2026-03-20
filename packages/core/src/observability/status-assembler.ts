import type { IssueOrchestrationRecord } from "../contracts/issue-orchestration.js";
import type { OrchestratorRunRecord } from "../contracts/status-surface.js";

export function isMatchingIssueRun(
  run: OrchestratorRunRecord | null,
  projectId: string,
  issueId: string,
  issueIdentifier: string
): run is OrchestratorRunRecord {
  return Boolean(
    run &&
      run.projectId === projectId &&
      (run.issueId === issueId || run.issueIdentifier === issueIdentifier)
  );
}

export function mapIssueOrchestrationStateToStatus(
  state: IssueOrchestrationRecord["state"]
): string {
  switch (state) {
    case "claimed":
      return "starting";
    case "running":
      return "running";
    case "retry_queued":
      return "retrying";
    case "released":
      return "released";
    case "unclaimed":
      return "pending";
    default:
      return state;
  }
}
