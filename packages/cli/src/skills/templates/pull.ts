import type { SkillTemplateContext } from "../types.js";
import { renderSkillDocument } from "./document.js";

export function generatePullSkill(_ctx: SkillTemplateContext): string {
  const lines: string[] = [];

  lines.push("# /pull — Git Pull / Sync Workflow");
  lines.push("");
  lines.push("## Trigger");
  lines.push("");
  lines.push(
    "Use this skill to sync the current branch with the latest `origin/main`"
  );
  lines.push("before starting work or before creating a PR.");
  lines.push("");
  lines.push("## Flow");
  lines.push("");
  lines.push("1. Fetch latest from remote:");
  lines.push("   ```bash");
  lines.push("   git fetch origin");
  lines.push("   ```");
  lines.push("2. Merge into current branch:");
  lines.push("   ```bash");
  lines.push("   git merge origin/main");
  lines.push("   ```");
  lines.push("3. If conflicts arise:");
  lines.push("   - Resolve each conflict file");
  lines.push("   - Run tests to confirm nothing broke");
  lines.push(
    "   - Commit the merge: `git commit` (merge commit message is auto-generated)"
  );
  lines.push(
    "4. Re-run tests after merge to confirm the integrated state is clean"
  );
  lines.push("5. Record pull skill evidence in workpad Notes:");
  lines.push("   - merge source (e.g. `origin/main`)");
  lines.push("   - result: `clean` or `conflicts resolved`");
  lines.push("   - resulting HEAD short SHA: `git rev-parse --short HEAD`");
  lines.push("");
  lines.push("## Rules");
  lines.push("");
  lines.push("- Always pull before creating a PR");
  lines.push("- Always pull at the start of a new work session");
  lines.push("- Record the pull evidence in the workpad before proceeding");

  return renderSkillDocument({
    name: "pull",
    description:
      "Sync the current branch with the latest remote base before implementation or review handoff.",
    bodyLines: lines,
  });
}
