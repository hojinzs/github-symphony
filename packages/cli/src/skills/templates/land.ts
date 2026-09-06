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
  lines.push("## Merged-PR Precedence Guard");
  lines.push("");
  lines.push(
    "Before any pre-flight check or failure classification, read `state` and `mergeCommit` with `gh pr view <pr-number> --json state,mergeCommit` (always pass the PR number — the head branch may already be deleted)."
  );
  lines.push(
    "If the PR is `MERGED`, skip every pre-flight and failure path, record the merge commit, transition `Land` → `Done` through the gh-project skill, and exit. Never return a merged PR to `Ready`, even if its head branch was deleted."
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
  lines.push(
    "   Save the latest qualifying human approval's `submittedAt`. Read review threads with `comments(first: 1) { nodes { createdAt } }`. An unresolved actionable thread created after the approval fails Land as rework; a thread created at or before that approval is absorbed by the approval and does not block Land."
  );
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
  lines.push(
    "1. Run the Merged-PR Precedence Guard, then run pre-flight checks only if the PR remains open. The human-owned `In review` → `Land` transition is already confirmed before this skill runs; do not replay it or post a duplicate status comment."
  );
  lines.push("2. If all checks pass, merge the PR:");
  lines.push("   ```bash");
  lines.push("   gh pr merge --squash    # squash merge (default)");
  lines.push("   # or: gh pr merge --merge   # merge commit");
  lines.push("   # or: gh pr merge --rebase  # rebase merge");
  lines.push("   ```");
  lines.push("   Use squash merge per project policy.");
  lines.push("3. On merge success:");
  lines.push(
    "   - Prepare the policy-authored `Land → Done` body, then send transition intent through the **gh-project skill**"
  );
  lines.push(
    "   - After confirmed readback, publish the prepared body through the host-side `github_graphql` `addComment` mutation"
  );
  lines.push("4. On merge failure:");
  lines.push("   - Re-run the Merged-PR Precedence Guard first");
  lines.push("   - Record the failure reason in workpad Notes");
  lines.push("   - Resolve the blocking issue (re-run pre-flight checks)");
  lines.push("   - Retry the merge");
  lines.push("5. Loop until merged or blocked by an unresolvable issue");
  lines.push("");
  lines.push("## Failure Handling");
  lines.push("");
  lines.push(
    "1. **Merged-PR precedence is always first.** Re-read the linked PR's `state` before classifying a failure. If it is `MERGED`, discard the pending failure classification, record the merge commit SHA, transition `Land` → `Done` through the gh-project skill, and exit. A deleted head branch is not rework after merge."
  );
  lines.push(
    "2. **Rework failure** — failed required CI, a source-file merge conflict, a missing required changeset, or an unresolved actionable review thread created after the latest qualifying human approval on the current head (compare its first comment's `createdAt` with the approval's `submittedAt`). An unresolved actionable thread created at or before that approval is absorbed by the approval and does not block Land."
  );
  lines.push(
    "3. Send only transition intent through the gh-project skill; after confirmed readback, publish the prepared body through `github_graphql`."
  );
  lines.push("");
  lines.push("## Guardrails");
  lines.push("");
  lines.push(
    "- Run the Merged-PR Precedence Guard before pre-flight and before applying any failure classification"
  );
  lines.push(
    "- Never treat a deleted head branch as rework after the linked PR has merged"
  );
  lines.push("");
  lines.push("## Rules");
  lines.push("");
  lines.push("- Never call `gh pr merge` without completing pre-flight checks");
  lines.push(
    "- Status transition to Done MUST go through the gh-project skill"
  );
  lines.push(
    "- Transition comments MUST be published by the agent after gh-project confirms readback; never send `comment_body` to the tracker-state API"
  );
  lines.push(
    "- If any pre-flight check fails, do not merge — fix the issue first"
  );
  lines.push(
    "- Never classify or return a merged PR as rework; merged state always transitions to Done"
  );
  lines.push("- Record all merge attempts and outcomes in the workpad");

  return renderSkillDocument({
    name: "land",
    description:
      "Merge approved pull requests safely after verifying approvals, CI, and branch freshness.",
    bodyLines: lines,
  });
}
