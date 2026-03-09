import type {
  OrchestratorRunRecord,
  OrchestratorWorkspaceConfig,
  WorkspaceLeaseRecord,
  WorkspaceStatusSnapshot
} from "./status-surface.js";

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
};
