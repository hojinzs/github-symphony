import type {
  OrchestratorRunRecord,
  OrchestratorTenantConfig,
  TenantLeaseRecord,
  TenantStatusSnapshot
} from "./status-surface.js";
import type { IssueWorkspaceRecord } from "../domain/issue.js";
import type { OrchestratorEvent } from "../observability/structured-events.js";

export type OrchestratorStateStore = {
  loadTenantConfigs(): Promise<OrchestratorTenantConfig[]>;
  saveTenantConfig(config: OrchestratorTenantConfig): Promise<void>;
  loadTenantLeases(tenantId: string): Promise<TenantLeaseRecord[]>;
  saveTenantLeases(tenantId: string, leases: TenantLeaseRecord[]): Promise<void>;
  saveTenantStatus(status: TenantStatusSnapshot): Promise<void>;
  loadTenantStatus(tenantId: string): Promise<TenantStatusSnapshot | null>;
  loadRun(runId: string): Promise<OrchestratorRunRecord | null>;
  loadAllRuns(): Promise<OrchestratorRunRecord[]>;
  saveRun(run: OrchestratorRunRecord): Promise<void>;
  appendRunEvent(runId: string, event: OrchestratorEvent): Promise<void>;
  runDir(runId: string): string;
  tenantDir(tenantId: string): string;
  loadIssueWorkspace(tenantId: string, workspaceKey: string): Promise<IssueWorkspaceRecord | null>;
  loadIssueWorkspaces(tenantId: string): Promise<IssueWorkspaceRecord[]>;
  saveIssueWorkspace(record: IssueWorkspaceRecord): Promise<void>;
  removeIssueWorkspace(tenantId: string, workspaceKey: string): Promise<void>;
};
