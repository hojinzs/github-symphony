import type { SkillTemplateContext } from "../types.js";
import { renderSkillDocument } from "./document.js";

export function generateGhProjectSkill(_ctx: SkillTemplateContext): string {
  const lines: string[] = [];

  lines.push("# /gh-project — Orchestrator-owned Tracker State");
  lines.push("");
  lines.push("## Purpose");
  lines.push("");
  lines.push(
    "Request issue-scoped tracker state reads and transitions from the orchestrator,"
  );
  lines.push(
    "writing lifecycle comments before the request and correcting them if it fails."
  );
  lines.push("");
  lines.push("## Prerequisites");
  lines.push("");
  lines.push("- `SYMPHONY_ORCHESTRATOR_URL` is set by the current run");
  lines.push("- `SYMPHONY_RUN_ID` identifies the current run");
  lines.push(
    "- `SYMPHONY_ORCHESTRATOR_TOKEN` authenticates the worker without exposing the credential through status APIs"
  );
  lines.push(
    "- The orchestrator owns the canonical tracker item, provider quota, retry/backoff, mutation, and readback"
  );
  lines.push("");
  lines.push("## Operations");
  lines.push("");
  lines.push("### Read Current Issue State");
  lines.push("");
  lines.push(
    "Send an issue-scoped read intent and inspect the confirmed response:"
  );
  lines.push("");
  lines.push("```bash");
  lines.push("curl --fail-with-body --silent --show-error \\");
  lines.push('  -X POST "$SYMPHONY_ORCHESTRATOR_URL/api/v1/tracker-state" \\');
  lines.push('  -H "Content-Type: application/json" \\');
  lines.push('  -H "X-Symphony-Run-Id: $SYMPHONY_RUN_ID" \\');
  lines.push(
    '  -H "X-Symphony-Orchestrator-Token: $SYMPHONY_ORCHESTRATOR_TOKEN" \\'
  );
  lines.push('  --data \'{"type":"state-read"}\'');
  lines.push("```");
  lines.push("");
  lines.push("### Request Issue Status Transition");
  lines.push("");
  lines.push(
    "Send only transition intent. Use `jq` so state names and the reason are JSON-encoded safely:"
  );
  lines.push("");
  lines.push("```bash");
  lines.push('expected_state="In progress"');
  lines.push('target_state="In review"');
  lines.push('reason="PR created; validation passed"');
  lines.push("payload=$(jq -n \\");
  lines.push('  --arg expected "$expected_state" \\');
  lines.push('  --arg target "$target_state" \\');
  lines.push('  --arg reason "$reason" \\');
  lines.push(
    "  '{type:\"transition-request\", expected_state:$expected, target_state:$target, reason:$reason}')"
  );
  lines.push("response=$(curl --fail-with-body --silent --show-error \\");
  lines.push('  -X POST "$SYMPHONY_ORCHESTRATOR_URL/api/v1/tracker-state" \\');
  lines.push('  -H "Content-Type: application/json" \\');
  lines.push('  -H "X-Symphony-Run-Id: $SYMPHONY_RUN_ID" \\');
  lines.push(
    '  -H "X-Symphony-Orchestrator-Token: $SYMPHONY_ORCHESTRATOR_TOKEN" \\'
  );
  lines.push('  --data "$payload")');
  lines.push('printf "%s\\n" "$response"');
  lines.push('jq -e --arg target "$target_state" \\');
  lines.push(
    '  \'.ok == true and .outcome == "confirmed" and .state == $target\' <<<"$response"'
  );
  lines.push("```");
  lines.push("");
  lines.push("### Create Workpad Comment");
  lines.push("");
  lines.push("```bash");
  lines.push(
    "gh issue comment <issue-number> --repo <owner>/<repo> --body-file <workpad.md>"
  );
  lines.push("```");
  lines.push("");
  lines.push("### Update Existing Comment");
  lines.push("");
  lines.push("```bash");
  lines.push(
    "gh api -X PATCH /repos/<owner>/<repo>/issues/comments/<comment-id> \\"
  );
  lines.push("  -F body=@<workpad.md>");
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
    "- Never traverse provider boards or mutate tracker fields directly from a worker"
  );
  lines.push(
    "- Treat non-2xx responses, expected-state mismatches, and readback mismatches as failed transitions"
  );
  lines.push(
    "- Post the transition comment and workpad line **before** sending the transition request; a confirmed transition into a non-active state makes the issue ineligible and reconciliation can terminate the worker mid-turn, so deferred bookkeeping may never be written"
  );
  lines.push(
    '- When the response is not `.ok == true`, `.outcome == "confirmed"`, and the returned state matching the target, immediately post the `⚠️ Status transition failed` correction comment and workpad line'
  );
  lines.push(
    "- Before transitioning to a terminal state, verify the Completion Bar is satisfied:"
  );
  lines.push("  - All acceptance criteria checked");
  lines.push("  - All tests passing");
  lines.push("  - PR merged (if applicable)");
  lines.push(
    "- Do not transition issues to terminal states without explicit completion verification"
  );

  return renderSkillDocument({
    name: "gh-project",
    description:
      "Request run-scoped tracker states and transitions through the orchestrator.",
    bodyLines: lines,
  });
}
