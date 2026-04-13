import type { DetectedEnvironment } from "../detection/environment-detector.js";

export type SkillRuntime = "claude-code" | "codex";

export type SkillTemplateContext = {
  runtime: SkillRuntime | string; // string for custom
  projectId: string;
  githubProjectTitle: string;
  repositories: Array<{ owner: string; name: string }>;
  statusColumns: Array<{
    id: string; // option ID (needed for GitHub Project mutations)
    name: string;
    role: "active" | "wait" | "terminal" | null;
  }>;
  statusFieldId: string; // field ID (needed for gh project item-edit --field-id)
  contextYamlPath: string; // relative path
  referenceWorkflowPath: string; // relative path
  detectedEnvironment: Pick<
    DetectedEnvironment,
    "packageManager" | "testCommand" | "lintCommand" | "buildCommand" | "monorepo"
  >;
};

export type SkillTemplate = {
  name: string; // e.g., "gh-symphony"
  fileName: string; // e.g., "SKILL.md"
  generate: (context: SkillTemplateContext) => string;
};
