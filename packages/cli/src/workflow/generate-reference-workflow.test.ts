import { describe, expect, it } from "vitest";
import {
  generateReferenceWorkflow,
  type ReferenceWorkflowInput,
} from "./generate-reference-workflow.js";

const defaultInput: ReferenceWorkflowInput = {
  runtime: "codex",
  statusColumns: [
    { name: "Todo", role: "active" },
    { name: "In Progress", role: "active" },
    { name: "In Review", role: "wait" },
    { name: "Done", role: "terminal" },
  ],
  projectId: "PVT_abc123",
};

describe("generateReferenceWorkflow", () => {
  it("codex runtime produces codex.command containing codex", () => {
    const output = generateReferenceWorkflow({
      ...defaultInput,
      runtime: "codex",
    });
    expect(output).toContain("command: codex app-server");
  });

  it("claude-code runtime produces codex.command containing claude-code", () => {
    const output = generateReferenceWorkflow({
      ...defaultInput,
      runtime: "claude-code",
    });
    expect(output).toContain("command: claude-code");
  });

  it("custom runtime string is used as codex.command verbatim", () => {
    const output = generateReferenceWorkflow({
      ...defaultInput,
      runtime: "node worker.js",
    });
    expect(output).toContain("command: node worker.js");
  });

  it("contains all required section headers", () => {
    const output = generateReferenceWorkflow(defaultInput);

    expect(output).toContain("# Reference WORKFLOW.md — gh-symphony");
    expect(output).toContain("# ═══ FRONT MATTER FIELD REFERENCE ═══");
    expect(output).toContain("# ═══ PROMPT BODY REFERENCE ═══");
    expect(output).toContain("## Status Map");
    expect(output).toContain("## Default Posture");
    expect(output).toContain("## Related Skills");
    expect(output).toContain("## Step 0: Determine current state and route");
    expect(output).toContain("## Step 1: Start/continue execution");
    expect(output).toContain("## Step 2: Execution phase");
    expect(output).toContain("## Step 3: Human Review and merge handling");
    expect(output).toContain("## Step 4: Rework handling");
    expect(output).toContain("## PR Feedback Sweep Protocol");
    expect(output).toContain("## Completion Bar");
    expect(output).toContain("## Guardrails");
    expect(output).toContain("## Workpad Template");
  });

  it("Status Map contains all column names from input", () => {
    const output = generateReferenceWorkflow(defaultInput);

    expect(output).toContain("Todo");
    expect(output).toContain("In Progress");
    expect(output).toContain("In Review");
    expect(output).toContain("Done");
  });

  it("Status Map contains role action descriptions", () => {
    const output = generateReferenceWorkflow(defaultInput);

    expect(output).toContain(
      "Agent starts work immediately. Creates workpad and proceeds with implementation."
    );
    expect(output).toContain(
      "PR created. Awaiting human review. Agent is idle."
    );
    expect(output).toContain("Completed state. Agent exits.");
  });

  it("contains all 13 Default Posture items", () => {
    const output = generateReferenceWorkflow(defaultInput);

    expect(output).toContain("1. This is an unattended orchestration session.");
    expect(output).toContain("2. Exit early only for genuine blockers");
    expect(output).toContain(
      "3. In your final message, report only completed work and blockers."
    );
    expect(output).toContain(
      "4. Do not modify the issue body for planning or progress-tracking purposes."
    );
    expect(output).toContain(
      "5. If the issue is in a terminal state, do nothing and exit immediately."
    );
    expect(output).toContain("6. If you discover out-of-scope improvements");
    expect(output).toContain("7. Keep all commits as logical units");
    expect(output).toContain(
      "8. Do not make commits that break existing tests."
    );
    expect(output).toContain(
      "9. Verify all existing tests pass before creating a PR."
    );
    expect(output).toContain(
      "10. Create a workpad as an issue comment to track progress."
    );
    expect(output).toContain(
      "11. Use the gh-project skill to manage issue status."
    );
    expect(output).toContain(
      "12. When a blocker is found, record it in an issue comment"
    );
    expect(output).toContain(
      "13. Once your work is complete and the PR is merged, transition the issue to the Done state."
    );
  });

  it("does NOT contain double-brace template patterns", () => {
    const output = generateReferenceWorkflow(defaultInput);
    expect(output).not.toMatch(/\{\{[^}]+\}\}/);
  });

  it("includes projectId in front matter", () => {
    const output = generateReferenceWorkflow(defaultInput);
    expect(output).toContain("project_id: PVT_abc123");
  });

  it("does not include allowed_repositories in front matter", () => {
    const output = generateReferenceWorkflow(defaultInput);
    expect(output).not.toContain("allowed_repositories:");
  });

  it("includes active states in tracker section", () => {
    const output = generateReferenceWorkflow(defaultInput);
    expect(output).toContain("active_states:");
    expect(output).toContain("    - Todo");
    expect(output).toContain("    - In Progress");
  });

  it("includes terminal states in tracker section", () => {
    const output = generateReferenceWorkflow(defaultInput);
    expect(output).toContain("terminal_states:");
    expect(output).toContain("    - Done");
  });

  it("includes blocker_check_states set to first active column", () => {
    const output = generateReferenceWorkflow(defaultInput);
    expect(output).toContain("blocker_check_states:");
    expect(output).toContain("    - Todo");
  });

  it("handles null role columns in Status Map", () => {
    const output = generateReferenceWorkflow({
      ...defaultInput,
      statusColumns: [
        { name: "Backlog", role: null },
        ...defaultInput.statusColumns,
      ],
    });
    expect(output).toContain("Backlog");
    expect(output).toContain(
      "Role unset. Must be explicitly configured in WORKFLOW.md."
    );
  });

  it("includes standard runtime fields", () => {
    const output = generateReferenceWorkflow(defaultInput);
    expect(output).toContain("max_turns: 20");
    expect(output).toContain("read_timeout_ms: 5000");
    expect(output).toContain("turn_timeout_ms: 3600000");
    expect(output).toContain("interval_ms: 30000");
    expect(output).toContain("retry_base_delay_ms: 1000");
    expect(output).toContain("max_retry_backoff_ms: 30000");
  });

  it("includes hooks section with after_create", () => {
    const output = generateReferenceWorkflow(defaultInput);
    expect(output).toContain("after_create: hooks/after_create.sh");
    expect(output).toContain("before_run: null");
    expect(output).toContain("after_run: null");
    expect(output).toContain("before_remove: null");
    expect(output).toContain("timeout_ms: 60000");
  });
});
