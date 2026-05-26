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
    "",
    "Only these variables are supported by strict-mode prompt rendering.",
  ].join("\n");
}
