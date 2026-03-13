export type SkillRuntime = "claude-code" | "codex";

export type SkillTemplateContext = {
  runtime: SkillRuntime | string; // string for custom
  projectId: string;
  projectTitle: string;
  repositories: Array<{ owner: string; name: string }>;
  statusColumns: Array<{
    id: string; // option ID (needed for GitHub Project mutations)
    name: string;
    role: "active" | "wait" | "terminal" | null;
  }>;
  statusFieldId: string; // field ID (needed for gh project item-edit --field-id)
  contextYamlPath: string; // relative path
  referenceWorkflowPath: string; // relative path
};

export type SkillTemplate = {
  name: string; // e.g., "gh-symphony"
  fileName: string; // e.g., "SKILL.md"
  generate: (context: SkillTemplateContext) => string;
};
