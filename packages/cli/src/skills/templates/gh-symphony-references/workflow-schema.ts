import { generateReferenceWorkflow } from "../../../workflow/generate-reference-workflow.js";
import type { SkillTemplateContext } from "../../types.js";

export function generateWorkflowSchemaReference(
  ctx: SkillTemplateContext
): string {
  const reference = generateReferenceWorkflow({
    runtime: ctx.runtime,
    statusColumns: ctx.statusColumns.map((column) => ({
      name: column.name,
      role: column.role,
    })),
    projectId: ctx.projectId,
    priority: null,
    detectedEnvironment: ctx.detectedEnvironment,
  });

  return [
    reference,
    "",
    "## Blocker gating",
    "",
    "Missing `tracker.blocker_check_states` defaults to the first configured active state (`Todo` with built-in defaults).",
    "Use an explicit empty list (`blocker_check_states: []`) to disable blocker gating.",
    "That explicit opt-out intentionally diverges from the vendored Symphony specification's unconditional blocker rule.",
    "Missing `tracker.planning_states` remains disabled and is independent of blocker gating.",
    "Linear blockers are normalized from inverse relations of type `blocks`.",
    "",
    "## Supported Template Variables",
    "",
    "Use these in the WORKFLOW.md prompt body with double-brace syntax.",
    "",
    "| Variable | Description |",
    "| -------- | ----------- |",
    "| `issue.identifier` | Issue identifier, for example `acme/platform#42`. |",
    "| `issue.title` | Issue title. |",
    "| `issue.state` | Current tracker state. |",
    "| `issue.description` | Issue body. |",
    "| `issue.url` | Issue URL. |",
    "| `issue.repository` | Repository in `owner/name` form. |",
    "| `issue.number` | Issue number. |",
    "| `attempt` | Retry attempt number, or null on the first run. |",
    "| `execution_phase` | Normalized lifecycle classification: `planning`, `implementation`, or null. Classification alone does not gate agent behavior. |",
    "",
    "Only these variables are supported by strict-mode prompt rendering.",
  ].join("\n");
}
