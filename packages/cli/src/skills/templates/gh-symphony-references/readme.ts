import type { SkillTemplateContext } from "../../types.js";

export function generateGhSymphonyReferencesReadme(
  _ctx: SkillTemplateContext
): string {
  return [
    "# /gh-symphony references",
    "",
    "The /gh-symphony skill consults these files when designing or refining",
    "WORKFLOW.md.",
    "",
    "## Schema",
    "",
    "| File | What it is |",
    "| ---- | ---------- |",
    "| `workflow-schema.md` | All supported front matter fields and their types. |",
    "",
    "## Workflow prompt body postures",
    "",
    "When the user describes what the orchestration should do, pick the matching",
    "posture file(s) and use its prompt-body sections as the seed. Postures can be",
    "combined when the user's intent spans multiple categories.",
    "",
    "| File | Use when the user wants... |",
    "| ---- | -------------------------- |",
    "| `workflow-posture-implement.md` | Coding agent writes features / bug fixes (default). |",
    "| `workflow-posture-review.md` | Agent reviews PRs and leaves comments. No code writes. |",
    "| `workflow-posture-maintain.md` | Minimal-change maintenance: deps, lint sweeps, hygiene. |",
    "",
    "## Adding your own reference",
    "",
    "Drop a markdown file here with a descriptive name. The skill discovers files",
    "on each invocation; no code changes needed.",
  ].join("\n");
}
