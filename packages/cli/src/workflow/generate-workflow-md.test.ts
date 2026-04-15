import { describe, expect, it } from "vitest";
import { parseWorkflowMarkdown, renderPrompt } from "@gh-symphony/core";
import { DEFAULT_AFTER_CREATE_HOOK_PATH } from "./default-hooks.js";
import { generateWorkflowMarkdown } from "./generate-workflow-md.js";

describe("generateWorkflowMarkdown", () => {
  const defaultInput = {
    projectId: "PVT_abc123",
    stateFieldName: "Stage",
    priorityFieldName: "Priority",
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
    detectedEnvironment: {
      packageManager: "pnpm" as const,
      testCommand: "pnpm test",
      lintCommand: "pnpm lint",
      buildCommand: "pnpm build",
      monorepo: true,
    },
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

  it("emits tracker.priority_field when configured", () => {
    const markdown = generateWorkflowMarkdown(defaultInput);
    const parsed = parseWorkflowMarkdown(markdown, {});

    expect(markdown).toContain("priority_field: Priority");
    expect(parsed.tracker.priorityFieldName).toBe("Priority");
  });

  it("omits tracker.priority_field when not configured", () => {
    const markdown = generateWorkflowMarkdown({
      ...defaultInput,
      priorityFieldName: null,
    });
    const parsed = parseWorkflowMarkdown(markdown, {});

    expect(markdown).not.toContain("priority_field:");
    expect(parsed.tracker.priorityFieldName).toBeNull();
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

  it("points after_create at the scaffolded default hook path", () => {
    const markdown = generateWorkflowMarkdown(defaultInput);

    expect(markdown).toContain(`after_create: ${DEFAULT_AFTER_CREATE_HOOK_PATH}`);
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

  it("includes repository-specific validation guidance when commands are detected", () => {
    const markdown = generateWorkflowMarkdown(defaultInput);

    expect(markdown).toContain("### Repository Validation Guidance");
    expect(markdown).toContain("Detected repository validation commands:");
    expect(markdown).toContain("`pnpm test`");
    expect(markdown).toContain("`pnpm lint`");
    expect(markdown).toContain("`pnpm build`");
    expect(markdown).toContain("Use `pnpm` conventions");
    expect(markdown).toContain("This repository appears to be a monorepo");
  });

  it("keeps generic validation fallback when no scripts are detected", () => {
    const markdown = generateWorkflowMarkdown({
      ...defaultInput,
      detectedEnvironment: {
        packageManager: null,
        testCommand: null,
        lintCommand: null,
        buildCommand: null,
        monorepo: false,
      },
    });

    expect(markdown).toContain(
      "No repository-specific test/lint/build scripts were detected"
    );
    expect(markdown).not.toContain("Detected repository validation commands:");
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
