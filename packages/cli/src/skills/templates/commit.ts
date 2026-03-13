import type { SkillTemplateContext } from "../types.js";
import { renderSkillDocument } from "./document.js";

export function generateCommitSkill(_ctx: SkillTemplateContext): string {
  const lines: string[] = [];

  lines.push("# /commit — Clean Commit Workflow");
  lines.push("");
  lines.push("## Trigger");
  lines.push("");
  lines.push("Use this skill when creating commits during implementation.");
  lines.push("");
  lines.push("## Rules");
  lines.push("");
  lines.push("- Commit in logical units — one concern per commit");
  lines.push("- Never commit a broken intermediate state (tests must pass)");
  lines.push("- Never commit temporary debug code or commented-out blocks");
  lines.push("- Run tests before every commit");
  lines.push("");
  lines.push("## Format");
  lines.push("");
  lines.push("Use Conventional Commit format:");
  lines.push("");
  lines.push("```");
  lines.push("<type>(<scope>): <description>");
  lines.push("");
  lines.push("[optional body — explain WHY, not WHAT, 72 chars/line]");
  lines.push("");
  lines.push("[optional footer: Closes #N]");
  lines.push("```");
  lines.push("");
  lines.push("**Types**: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`");
  lines.push("");
  lines.push(
    "**Description**: imperative mood, 50 chars max, no period at end"
  );
  lines.push("");
  lines.push("## Examples");
  lines.push("");
  lines.push("```");
  lines.push("feat(auth): add OAuth2 token refresh");
  lines.push("fix(api): handle null response from upstream");
  lines.push("test(worker): add retry exhaustion coverage");
  lines.push("```");

  return renderSkillDocument({
    name: "commit",
    description:
      "Create clean, logically scoped commits that keep the repository in a shippable state.",
    bodyLines: lines,
  });
}
