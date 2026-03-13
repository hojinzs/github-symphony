import { describe, expect, it } from "vitest";
import { parseWorkflowMarkdown, renderPrompt } from "@gh-symphony/core";
import { generateWorkflowMarkdown } from "./generate-workflow-md.js";

describe("generateWorkflowMarkdown", () => {
  const defaultInput = {
    projectId: "PVT_abc123",
    stateFieldName: "Stage",
    mappings: {
      Queued: { role: "active" as const, goal: "Triage and plan the issue" },
      Doing: { role: "active" as const, goal: "Implement the solution" },
      Review: { role: "wait" as const },
      Done: { role: "terminal" as const },
    },
    lifecycle: {
      stateFieldName: "Stage",
      activeStates: ["Queued", "Doing"],
      terminalStates: ["Done"],
      blockerCheckStates: ["Queued"],
    },
    runtime: "codex",
  };

  it("generates valid WORKFLOW.md that round-trips through parseWorkflowMarkdown", () => {
    const markdown = generateWorkflowMarkdown(defaultInput);
    const parsed = parseWorkflowMarkdown(markdown, {});

    expect(parsed.format).toBe("front-matter");
    expect(parsed.githubProjectId).toBe("PVT_abc123");
  });

  it("produces lifecycle config matching the input", () => {
    const markdown = generateWorkflowMarkdown(defaultInput);
    const parsed = parseWorkflowMarkdown(markdown, {});

    expect(parsed.lifecycle.stateFieldName).toBe("Stage");
    expect(parsed.lifecycle.activeStates).toEqual(["Queued", "Doing"]);
    expect(parsed.lifecycle.terminalStates).toEqual(["Done"]);
    expect(parsed.lifecycle.blockerCheckStates).toEqual(["Queued"]);
  });

  it("includes a Status Map section in the prompt body", () => {
    const markdown = generateWorkflowMarkdown(defaultInput);

    expect(markdown).toContain("## Status Map");
    expect(markdown).toContain("**Queued** [active]");
    expect(markdown).toContain("**Done** [terminal]");
  });

  it("does not emit allowed_repositories", () => {
    const markdown = generateWorkflowMarkdown(defaultInput);

    expect(markdown).not.toContain("allowed_repositories:");
  });

  it("uses custom poll interval when provided", () => {
    const markdown = generateWorkflowMarkdown({
      ...defaultInput,
      pollIntervalMs: 15000,
    });
    const parsed = parseWorkflowMarkdown(markdown, {});

    expect(parsed.polling.intervalMs).toBe(15000);
  });

  it("resolves runtime agent command for codex", () => {
    const markdown = generateWorkflowMarkdown(defaultInput);

    expect(markdown).toContain("command: codex app-server");
  });

  it("resolves runtime agent command for claude-code", () => {
    const markdown = generateWorkflowMarkdown({
      ...defaultInput,
      runtime: "claude-code",
    });

    expect(markdown).toContain("command: claude-code");
  });

  it("uses custom runtime string as agent command", () => {
    const markdown = generateWorkflowMarkdown({
      ...defaultInput,
      runtime: "node worker.js",
    });

    expect(markdown).toContain("command: node worker.js");
  });

  it("includes template variables that resolve without errors", () => {
    const markdown = generateWorkflowMarkdown(defaultInput);

    expect(markdown).toContain("{{issue.identifier}}");
    expect(markdown).toContain("{{issue.title}}");
    expect(markdown).toContain("{{issue.state}}");
    expect(markdown).toContain("{{issue.description}}");
    expect(markdown).toContain("{{issue.repository}}");
    // Must NOT include unsupported variables
    expect(markdown).not.toContain("{{issue.labels}}");
  });

  it("includes Default Posture section", () => {
    const markdown = generateWorkflowMarkdown(defaultInput);

    expect(markdown).toContain("### Default Posture");
    expect(markdown).toContain("unattended orchestration session");
    expect(markdown).toContain("genuine blocker");
  });

  it("includes Guardrails section", () => {
    const markdown = generateWorkflowMarkdown(defaultInput);

    expect(markdown).toContain("### Guardrails");
    expect(markdown).toContain(
      "Do not edit the issue body for planning or progress tracking"
    );
    expect(markdown).toContain(
      "If the issue is in a terminal state, do nothing and exit"
    );
  });

  it("includes Workpad Template section", () => {
    const markdown = generateWorkflowMarkdown(defaultInput);

    expect(markdown).toContain("### Workpad Template");
    expect(markdown).toContain("## Workpad");
    expect(markdown).toContain("### Plan");
    expect(markdown).toContain("### Acceptance Criteria");
    expect(markdown).toContain("### Validation");
  });

  it("includes role descriptions in Status Map", () => {
    const markdown = generateWorkflowMarkdown(defaultInput);

    expect(markdown).toContain("Agent starts work immediately");
    expect(markdown).toContain("PR created, awaiting human review");
    expect(markdown).toContain("Completed, agent exits");
  });

  it("round-trips through parseWorkflowMarkdown and renderPrompt with strict mode", () => {
    const markdown = generateWorkflowMarkdown(defaultInput);
    const parsed = parseWorkflowMarkdown(markdown, {});

    const mockVars = {
      issue: {
        id: "test-id-1",
        identifier: "owner/repo#1",
        title: "Test issue",
        state: "Queued",
        description: "Test description",
        url: "https://github.com/owner/repo/issues/1",
        repository: "owner/repo",
        number: 1,
      },
      attempt: null,
    };

    // This should NOT throw when strict mode is enabled
    const rendered = renderPrompt(parsed.promptTemplate, mockVars, {
      strict: true,
    });

    expect(rendered).toContain("Test issue");
    expect(rendered).toContain("owner/repo");
    expect(rendered).toContain("Test description");
    expect(rendered).not.toContain("{{");
  });

  it("maintains backward compatibility with existing test fixtures", () => {
    const markdown = generateWorkflowMarkdown(defaultInput);
    const parsed = parseWorkflowMarkdown(markdown, {});

    // Verify all original expectations still hold
    expect(parsed.format).toBe("front-matter");
    expect(parsed.githubProjectId).toBe("PVT_abc123");
    expect(parsed.lifecycle.stateFieldName).toBe("Stage");
    expect(parsed.lifecycle.activeStates).toEqual(["Queued", "Doing"]);
    expect(parsed.lifecycle.terminalStates).toEqual(["Done"]);
  });
});
