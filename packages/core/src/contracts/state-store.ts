import type {
  OrchestratorRunRecord,
  OrchestratorWorkspaceConfig,
  WorkspaceLeaseRecord,
  WorkspaceStatusSnapshot
} from "./status-surface.js";
import type { IssueWorkspaceRecord } from "../domain/issue.js";
import type { OrchestratorEvent } from "../observability/structured-events.js";

export type OrchestratorStateStore = {
  loadWorkspaceConfigs(): Promise<OrchestratorWorkspaceConfig[]>;
  saveWorkspaceConfig(config: OrchestratorWorkspaceConfig): Promise<void>;
  loadWorkspaceLeases(workspaceId: string): Promise<WorkspaceLeaseRecord[]>;
  saveWorkspaceLeases(workspaceId: string, leases: WorkspaceLeaseRecord[]): Promise<void>;
  saveWorkspaceStatus(status: WorkspaceStatusSnapshot): Promise<void>;
  loadWorkspaceStatus(workspaceId: string): Promise<WorkspaceStatusSnapshot | null>;
  loadRun(runId: string): Promise<OrchestratorRunRecord | null>;
  loadAllRuns(): Promise<OrchestratorRunRecord[]>;
  saveRun(run: OrchestratorRunRecord): Promise<void>;
  appendRunEvent(runId: string, event: OrchestratorEvent): Promise<void>;
  runDir(runId: string): string;
  loadIssueWorkspace(workspaceId: string, workspaceKey: string): Promise<IssueWorkspaceRecord | null>;
  loadIssueWorkspaces(workspaceId: string): Promise<IssueWorkspaceRecord[]>;
  saveIssueWorkspace(record: IssueWorkspaceRecord): Promise<void>;
  removeIssueWorkspace(workspaceId: string, workspaceKey: string): Promise<void>;
};
