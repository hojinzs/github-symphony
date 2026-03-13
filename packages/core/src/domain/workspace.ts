export const WORKSPACE_STATUS_LABELS = {
  provisioning: "Provisioning",
  idle: "Idle",
  running: "Running",
  degraded: "Needs attention"
} as const;

export type WorkspaceStatus = keyof typeof WORKSPACE_STATUS_LABELS;

export type RepositoryRef = {
  owner: string;
  name: string;
  cloneUrl: string;
};

export type WorkspaceDraft = {
  name: string;
  repositories: RepositoryRef[];
};
