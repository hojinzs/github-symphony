import type { SkillTemplateContext } from "../types.js";
import { renderSkillDocument } from "./document.js";

export function generateLandSkill(_ctx: SkillTemplateContext): string {
  const lines: string[] = [];

  lines.push("# /land — PR Merge Workflow");
  lines.push("");
  lines.push("## Trigger");
  lines.push("");
  lines.push(
    "Use this skill when the issue is in the Merging state (PR approved by human)."
  );
  lines.push(
    "Do NOT call `gh pr merge` directly — always go through this flow."
  );
  lines.push("");
  lines.push("## Pre-flight Checks");
  lines.push("");
  lines.push("Before merging, verify ALL of the following:");
  lines.push("");
  lines.push("1. **PR is approved**:");
  lines.push("   ```bash");
  lines.push(
    "   gh pr view --json reviews --jq '.reviews[] | select(.state == \"APPROVED\")'"
  );
  lines.push("   ```");
  lines.push("2. **All CI checks are green**:");
  lines.push("   ```bash");
  lines.push("   gh pr checks");
  lines.push("   ```");
  lines.push("3. **Branch is up-to-date with base**:");
  lines.push("   ```bash");
  lines.push(
    "   git fetch origin && git merge-base --is-ancestor origin/main HEAD"
  );
  lines.push("   ```");
  lines.push("   If not up-to-date, run the `/pull` skill first.");
  lines.push("");
  lines.push("## Flow");
  lines.push("");
  lines.push("1. Run all pre-flight checks above");
  lines.push("2. If all checks pass, merge the PR:");
  lines.push("   ```bash");
  lines.push("   gh pr merge --squash    # squash merge (default)");
  lines.push("   # or: gh pr merge --merge   # merge commit");
  lines.push("   # or: gh pr merge --rebase  # rebase merge");
  lines.push("   ```");
  lines.push("   Choose the merge strategy per project policy.");
  lines.push("3. On merge success:");
  lines.push(
    "   - Use the **gh-project skill** to transition the issue status to Done"
  );
  lines.push("   - Do NOT call status APIs directly — delegate to gh-project");
  lines.push("4. On merge failure:");
  lines.push("   - Record the failure reason in workpad Notes");
  lines.push("   - Resolve the blocking issue (re-run pre-flight checks)");
  lines.push("   - Retry the merge");
  lines.push("5. Loop until merged or blocked by an unresolvable issue");
  lines.push("");
  lines.push("## Rules");
  lines.push("");
  lines.push("- Never call `gh pr merge` without completing pre-flight checks");
  lines.push(
    "- Status transition to Done MUST go through the gh-project skill"
  );
  lines.push(
    "- If any pre-flight check fails, do not merge — fix the issue first"
  );
  lines.push("- Record all merge attempts and outcomes in the workpad");

  return renderSkillDocument({
    name: "land",
    description:
      "Merge approved pull requests safely after verifying approvals, CI, and branch freshness.",
    bodyLines: lines,
  });
}
