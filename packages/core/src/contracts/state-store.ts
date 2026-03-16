import type {
  IssueStatusEvent,
  OrchestratorRunRecord,
  OrchestratorProjectConfig,
  ProjectStatusSnapshot
} from "./status-surface.js";
import type { IssueOrchestrationRecord } from "./issue-orchestration.js";
import type { IssueWorkspaceRecord } from "../domain/issue.js";
import type { OrchestratorEvent } from "../observability/structured-events.js";

export type OrchestratorStateStore = {
  loadProjectConfig(projectId: string): Promise<OrchestratorProjectConfig | null>;
  saveProjectConfig(config: OrchestratorProjectConfig): Promise<void>;
  loadProjectIssueOrchestrations(
    projectId: string
  ): Promise<IssueOrchestrationRecord[]>;
  saveProjectIssueOrchestrations(
    projectId: string,
    issues: IssueOrchestrationRecord[]
  ): Promise<void>;
  saveProjectStatus(status: ProjectStatusSnapshot): Promise<void>;
  loadProjectStatus(projectId: string): Promise<ProjectStatusSnapshot | null>;
  loadRun(runId: string): Promise<OrchestratorRunRecord | null>;
  loadAllRuns(): Promise<OrchestratorRunRecord[]>;
  saveRun(run: OrchestratorRunRecord): Promise<void>;
  appendRunEvent(runId: string, event: OrchestratorEvent): Promise<void>;
  loadRecentRunEvents(runId: string, limit?: number): Promise<IssueStatusEvent[]>;
  runDir(runId: string): string;
  projectDir(projectId: string): string;
  loadIssueWorkspace(projectId: string, workspaceKey: string): Promise<IssueWorkspaceRecord | null>;
  loadIssueWorkspaces(projectId: string): Promise<IssueWorkspaceRecord[]>;
  saveIssueWorkspace(record: IssueWorkspaceRecord): Promise<void>;
  removeIssueWorkspace(projectId: string, workspaceKey: string): Promise<void>;
};
