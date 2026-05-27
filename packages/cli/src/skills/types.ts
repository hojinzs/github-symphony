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
  detectedEnvironment: Pick<
    DetectedEnvironment,
    | "packageManager"
    | "testCommand"
    | "lintCommand"
    | "buildCommand"
    | "monorepo"
  >;
};

export type SkillFile = {
  relativePath: string; // e.g., "SKILL.md", "references/workflow-posture-implement.md"
  generate: (context: SkillTemplateContext) => string;
};

export type SkillTemplate = {
  name: string; // e.g., "gh-symphony"
  files: SkillFile[]; // 1+
};
