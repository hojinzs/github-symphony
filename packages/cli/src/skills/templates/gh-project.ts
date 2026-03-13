import type { SkillTemplateContext } from "../types.js";

export function generateGhProjectSkill(ctx: SkillTemplateContext): string {
  const lines: string[] = [];

  lines.push("# /gh-project — GitHub Project v2 Status Management");
  lines.push("");
  lines.push("## Purpose");
  lines.push("");
  lines.push(
    "Interact with the GitHub Project v2 board to manage issue status,"
  );
  lines.push("create workpad comments, and handle follow-up issues.");
  lines.push("");
  lines.push("## Prerequisites");
  lines.push("");
  lines.push("- `gh` CLI is authenticated (`gh auth status`)");
  lines.push(
    `- \`${ctx.contextYamlPath}\` exists with field IDs and option IDs`
  );
  lines.push("");
  lines.push("## Column ID Quick Reference");
  lines.push("");
  lines.push(`Status Field ID: \`${ctx.statusFieldId}\``);
  lines.push("");
  lines.push("| Column Name | Role | Option ID |");
  lines.push("|-------------|------|-----------|");
  for (const col of ctx.statusColumns) {
    const role = col.role ?? "unknown";
    lines.push(`| ${col.name} | ${role} | \`${col.id}\` |`);
  }
  lines.push("");
  lines.push("## Operations");
  lines.push("");
  lines.push("### Change Issue Status");
  lines.push("");
  lines.push(
    "Use `gh project item-edit` with the field ID and option ID from the table above:"
  );
  lines.push("");
  lines.push("```bash");
  lines.push("# Get the project item ID for an issue");
  lines.push(
    "gh project item-list <project-number> --owner <owner> --format json \\"
  );
  lines.push(
    "  | jq '.items[] | select(.content.number == <issue-number>) | .id'"
  );
  lines.push("");
  lines.push("# Update the status field");
  lines.push(`gh project item-edit \\`);
  lines.push(`  --project-id ${ctx.projectId} \\`);
  lines.push(`  --id <item-id> \\`);
  lines.push(`  --field-id ${ctx.statusFieldId} \\`);
  lines.push(`  --single-select-option-id <option-id-from-table-above>`);
  lines.push("```");
  lines.push("");
  lines.push("### Create Workpad Comment");
  lines.push("");
  lines.push("```bash");
  lines.push(
    'gh issue comment <issue-number> --repo <owner>/<repo> --body "## Workpad\\n\\n### Plan\\n- [ ] Task 1"'
  );
  lines.push("```");
  lines.push("");
  lines.push("### Update Existing Comment");
  lines.push("");
  lines.push("```bash");
  lines.push(
    "gh api -X PATCH /repos/<owner>/<repo>/issues/comments/<comment-id> \\"
  );
  lines.push('  -f body="## Workpad\\n\\n### Plan\\n- [x] Task 1 (done)"');
  lines.push("```");
  lines.push("");
  lines.push("### Create Follow-up Issue");
  lines.push("");
  lines.push("```bash");
  lines.push("gh issue create --repo <owner>/<repo> \\");
  lines.push('  --title "Follow-up: <title>" \\');
  lines.push('  --body "<description>" \\');
  lines.push('  --label "backlog"');
  lines.push("```");
  lines.push("");
  lines.push("### Add Label");
  lines.push("");
  lines.push("```bash");
  lines.push(
    'gh issue edit <issue-number> --repo <owner>/<repo> --add-label "<label>"'
  );
  lines.push("```");
  lines.push("");
  lines.push("## Rules");
  lines.push("");
  lines.push(
    "- Always follow the WORKFLOW.md status map flow for state transitions"
  );
  lines.push(
    "- Before transitioning to a terminal state, verify the Completion Bar is satisfied:"
  );
  lines.push("  - All acceptance criteria checked");
  lines.push("  - All tests passing");
  lines.push("  - PR merged (if applicable)");
  lines.push(
    "- Use the Column ID Quick Reference table above for all status transitions"
  );
  lines.push(
    "- Do not transition issues to terminal states without explicit completion verification"
  );

  return lines.join("\n");
}
