import type {
  IssueStatusEvent,
  OrchestratorRunRecord,
  OrchestratorProjectConfig,
  ProjectStatusSnapshot,
} from "./status-surface.js";
import type { IssueOrchestrationRecord } from "./issue-orchestration.js";
import type { IssueWorkspaceRecord } from "../domain/issue.js";
import type { OrchestratorEvent } from "../observability/structured-events.js";

export type OrchestratorStateStore = {
  // P1 single-repo transition: projectId is optional at the contract boundary
  // so later phases can remove the legacy project namespace incrementally.
  // Legacy layout implementations may still require it until migration ships.
  loadProjectConfig(
    projectId?: string
  ): Promise<OrchestratorProjectConfig | null>;
  saveProjectConfig(config: OrchestratorProjectConfig): Promise<void>;
  loadProjectIssueOrchestrations(
    projectId?: string
  ): Promise<IssueOrchestrationRecord[]>;
  saveProjectIssueOrchestrations(
    projectId: string | undefined,
    issues: IssueOrchestrationRecord[]
  ): Promise<void>;
  saveProjectStatus(status: ProjectStatusSnapshot): Promise<void>;
  loadProjectStatus(projectId?: string): Promise<ProjectStatusSnapshot | null>;
  loadRun(
    runId: string,
    projectId?: string
  ): Promise<OrchestratorRunRecord | null>;
  loadAllRuns(): Promise<OrchestratorRunRecord[]>;
  saveRun(run: OrchestratorRunRecord): Promise<void>;
  appendRunEvent(runId: string, event: OrchestratorEvent): Promise<void>;
  loadRecentRunEvents(
    runId: string,
    limit?: number,
    projectId?: string
  ): Promise<IssueStatusEvent[]>;
  runDir(runId: string, projectId?: string): string;
  projectDir(projectId?: string): string;
  loadIssueWorkspace(
    projectId: string | undefined,
    workspaceKey: string
  ): Promise<IssueWorkspaceRecord | null>;
  loadIssueWorkspaces(projectId?: string): Promise<IssueWorkspaceRecord[]>;
  saveIssueWorkspace(record: IssueWorkspaceRecord): Promise<void>;
  removeIssueWorkspace(
    projectId: string | undefined,
    workspaceKey: string
  ): Promise<void>;
};
