import type { SkillTemplateContext } from "../types.js";

export function generatePushSkill(_ctx: SkillTemplateContext): string {
  const lines: string[] = [];

  lines.push("# /push — Git Push Workflow");
  lines.push("");
  lines.push("## Trigger");
  lines.push("");
  lines.push(
    "Use this skill when publishing local commits to the remote branch."
  );
  lines.push("");
  lines.push("## Flow");
  lines.push("");
  lines.push("1. Run local tests and lint — ensure they pass before pushing");
  lines.push("2. Push to remote:");
  lines.push("   ```bash");
  lines.push("   git push origin <branch>        # subsequent pushes");
  lines.push("   git push -u origin <branch>     # first push (sets upstream)");
  lines.push("   ```");
  lines.push("3. If push is rejected (non-fast-forward):");
  lines.push("   - Run `git fetch origin && git merge origin/main`");
  lines.push("   - Resolve any conflicts");
  lines.push("   - Re-run tests");
  lines.push("   - Push again");
  lines.push("4. Record push result in workpad Notes");
  lines.push("");
  lines.push("## Rules");
  lines.push("");
  lines.push("- Never use `--force` (destructive)");
  lines.push(
    "- Only use `--force-with-lease` if absolutely necessary — record the reason in workpad"
  );
  lines.push("- Verify CI starts after push (check GitHub Actions tab)");
  lines.push("- Do not push directly to `main` or `master`");

  return lines.join("\n");
}
