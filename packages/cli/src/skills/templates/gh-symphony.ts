import type { SkillTemplateContext } from "../types.js";
import { renderSkillDocument } from "./document.js";

export function generateGhSymphonySkill(ctx: SkillTemplateContext): string {
  const lines: string[] = [];

  lines.push("# /gh-symphony — WORKFLOW.md Design & Refinement");
  lines.push("");
  lines.push("## Trigger");
  lines.push("");
  lines.push("Use this skill when you want to:");
  lines.push("- Create a new WORKFLOW.md for a GitHub Symphony project");
  lines.push("- Refine or improve an existing WORKFLOW.md");
  lines.push("- Validate that a WORKFLOW.md is correctly structured");
  lines.push("");
  lines.push("## Prerequisites");
  lines.push("");
  lines.push(
    `- \`${ctx.contextYamlPath}\` must exist (contains GitHub Project metadata)`
  );
  lines.push(
    `- \`${ctx.referenceWorkflowPath}\` must exist (annotated reference template)`
  );
  lines.push("- `gh` CLI must be authenticated");
  lines.push("");
  lines.push("## Mode Detection");
  lines.push("");
  lines.push("Check if `WORKFLOW.md` exists in the current directory:");
  lines.push("- **Not found** → enter **Design Mode** (create from scratch)");
  lines.push("- **Found** → ask user: refine existing or validate only?");
  lines.push("  - Refine → enter **Refine Mode**");
  lines.push("  - Validate → enter **Validate Mode**");
  lines.push("");
  lines.push("## Design Mode");
  lines.push("");
  lines.push(
    `1. Read \`${ctx.contextYamlPath}\` to understand the project structure`
  );
  lines.push(
    `2. Read \`${ctx.referenceWorkflowPath}\` as the annotated reference`
  );
  lines.push("3. Ask the user these key questions:");
  lines.push("   - Which status columns should be **active** (agent works)?");
  lines.push("   - Which should be **wait** (agent pauses for human)?");
  lines.push("   - Which should be **terminal** (agent stops)?");
  lines.push("   - What runtime is being used? (codex / claude-code / custom)");
  lines.push("   - Any custom hooks needed? (after_create, before_run, etc.)");
  lines.push(
    "4. Generate WORKFLOW.md using the reference as a structural guide"
  );
  lines.push("5. Validate the generated file (see Validate Mode)");
  lines.push("");
  lines.push("## Refine Mode");
  lines.push("");
  lines.push("1. Read the current `WORKFLOW.md`");
  lines.push(`2. Read \`${ctx.referenceWorkflowPath}\` for comparison`);
  lines.push("3. Identify missing or incomplete sections:");
  lines.push("   - Status Map with role annotations");
  lines.push("   - Default Posture / Agent Instructions");
  lines.push("   - Guardrails section");
  lines.push("   - Workpad Template");
  lines.push("   - Step 0 routing logic");
  lines.push("4. Propose improvements and apply with user confirmation");
  lines.push("5. Validate the refined file");
  lines.push("");
  lines.push("## Validate Mode");
  lines.push("");
  lines.push("Check the WORKFLOW.md for:");
  lines.push("- Front matter is valid YAML");
  lines.push(
    "- Required fields are present (see Supported Front Matter Fields)"
  );
  lines.push(
    "- Template variables use only supported names (see Supported Template Variables)"
  );
  lines.push("- Status Map matches the lifecycle configuration");
  lines.push(
    "- No unsupported double-brace variable patterns (only the 8 listed below are valid)"
  );
  lines.push("");
  lines.push("## Supported Front Matter Fields");
  lines.push("");
  lines.push("```yaml");
  lines.push("tracker:");
  lines.push("  kind: github-project");
  lines.push("  project_id: PVT_xxx");
  lines.push("  state_field: Status");
  lines.push("  active_states: [Todo, In Progress]");
  lines.push("  terminal_states: [Done, Cancelled]");
  lines.push("  blocker_check_states: [Blocked]");
  lines.push("polling:");
  lines.push("  interval_ms: 30000");
  lines.push("workspace:");
  lines.push("  root: .runtime/symphony-workspaces");
  lines.push("hooks:");
  lines.push("  after_create: |");
  lines.push("    git clone --depth 1 https://github.com/owner/repo .");
  lines.push("  before_run: null");
  lines.push("  after_run: null");
  lines.push("  before_remove: null");
  lines.push("  timeout_ms: 60000");
  lines.push("agent:");
  lines.push("  max_concurrent_agents: 10");
  lines.push("  max_retry_backoff_ms: 30000");
  lines.push("  retry_base_delay_ms: 1000");
  lines.push("  max_turns: 20");
  lines.push("codex:");
  lines.push("  command: codex app-server");
  lines.push("  read_timeout_ms: 5000");
  lines.push("  turn_timeout_ms: 3600000");
  lines.push("  stall_timeout_ms: 300000");
  lines.push("```");
  lines.push("");
  lines.push("## Supported Template Variables");
  lines.push("");
  lines.push("Use these in the WORKFLOW.md prompt body (double-brace syntax):");
  lines.push("");
  lines.push("| Variable | Description |");
  lines.push("|----------|-------------|");
  lines.push("| `issue.identifier` | e.g. `acme/platform#42` |");
  lines.push("| `issue.title` | Issue title |");
  lines.push("| `issue.state` | Current tracker state |");
  lines.push("| `issue.description` | Issue body |");
  lines.push("| `issue.url` | Issue URL |");
  lines.push("| `issue.repository` | `owner/name` |");
  lines.push("| `issue.number` | Issue number |");
  lines.push("| `attempt` | Retry attempt number (null on first run) |");
  lines.push("");
  lines.push(
    "**Important**: Only these 8 variables are supported. Using any other variable"
  );
  lines.push("will cause a runtime error (strict mode validation).");
  lines.push("");
  lines.push("## Related Skills");
  lines.push("");
  lines.push(
    "- `/gh-project` — interact with GitHub Project v2 board (status transitions, workpad comments)"
  );
  lines.push(
    "- `/commit` — produce clean, logical commits during implementation"
  );
  lines.push("- `/push` — keep remote branch current and publish updates");
  lines.push("- `/pull` — sync branch with latest origin/main before handoff");
  lines.push("- `/land` — merge approved PR and transition issue to Done");

  return renderSkillDocument({
    name: "gh-symphony",
    description:
      "Design, refine, and validate repository WORKFLOW.md files for GitHub Symphony projects.",
    bodyLines: lines,
  });
}
