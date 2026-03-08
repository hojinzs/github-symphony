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
  promptGuidelines: string;
  repositories: RepositoryRef[];
};

export * from "./tracker-contract.js";
export * from "./workflow-lifecycle.js";
export * from "./workflow-parser.js";
export * from "./github-project-tracker.js";
