import { describe, expect, it } from "vitest";
import { parseWorkflowMarkdown, renderPrompt } from "@gh-symphony/core";
import {
  CLAUDE_ISOLATION_OFF_NOTE,
  CLAUDE_PERMISSIVE_ISOLATION_NOTE,
  CLAUDE_RUNTIME_CONSTRAINTS_SECTION,
  CLAUDE_RUNTIME_PROMPT_PREAMBLE,
} from "../prompts/runtime-claude-constraints.js";
import { DEFAULT_AFTER_CREATE_HOOK_PATH } from "./default-hooks.js";
import { generateWorkflowMarkdown } from "./generate-workflow-md.js";

describe("generateWorkflowMarkdown", () => {
  const defaultInput = {
    projectId: "PVT_abc123",
    stateFieldName: "Stage",
    priority: {
      source: "project-field" as const,
      field: "Priority",
      values: {
        P0: 0,
        P1: 1,
      },
    },
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
      planningStates: ["Queued"],
    },
    runtime: "codex-app-server",
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
    expect(parsed.lifecycle.planningStates).toEqual(["Queued"]);
  });

  it("emits empty blocker and planning state lists explicitly", () => {
    const markdown = generateWorkflowMarkdown({
      ...defaultInput,
      lifecycle: {
        ...defaultInput.lifecycle,
        blockerCheckStates: [],
        planningStates: [],
      },
    });
    const parsed = parseWorkflowMarkdown(markdown, {});

    expect(markdown).toContain("blocker_check_states: []");
    expect(markdown).toContain("planning_states: []");
    expect(parsed.lifecycle.blockerCheckStates).toEqual([]);
    expect(parsed.lifecycle.planningStates).toEqual([]);
  });

  it("emits explicit project-field priority mapping when configured", () => {
    const markdown = generateWorkflowMarkdown(defaultInput);
    const parsed = parseWorkflowMarkdown(markdown, {});

    expect(markdown).toContain("priority:");
    expect(markdown).toContain("source: project-field");
    expect(markdown).toContain('field: "Priority"');
    expect(markdown).toContain('"P0": 0');
    expect(markdown).not.toContain("priority_field:");
    expect(parsed.tracker.priority).toEqual(defaultInput.priority);
    expect(parsed.tracker.priorityFieldName).toBeNull();
  });

  it("emits disabled priority scaffold with templates when no field is configured", () => {
    const markdown = generateWorkflowMarkdown({
      ...defaultInput,
      priority: { source: "disabled" as const },
      includePriorityTemplates: true,
    });
    const parsed = parseWorkflowMarkdown(markdown, {});

    expect(markdown).not.toContain("priority_field:");
    expect(markdown).toContain("source: disabled");
    expect(markdown).toContain(
      "# Priority dispatch is disabled until an operator chooses one explicit source."
    );
    expect(markdown).toContain(
      "# Optional template: project-field priority source."
    );
    expect(markdown).toContain("# Optional template: labels priority source.");
    expect(parsed.tracker.priority).toEqual({ source: "disabled" });
    expect(parsed.tracker.priorityFieldName).toBeNull();
  });

  it("emits explicit labels priority mapping when configured", () => {
    const markdown = generateWorkflowMarkdown({
      ...defaultInput,
      priority: {
        source: "labels" as const,
        labels: {
          "priority: p0": 0,
          "priority: p1": 1,
        },
      },
    });
    const parsed = parseWorkflowMarkdown(markdown, {});

    expect(markdown).toContain("source: labels");
    expect(markdown).toContain('"priority: p0": 0');
    expect(markdown).not.toContain("priority_field:");
    expect(parsed.tracker.priority).toEqual({
      source: "labels",
      labels: {
        "priority: p0": 0,
        "priority: p1": 1,
      },
    });
  });

  it("round-trips escaped priority field and label names", () => {
    const priority = {
      source: "labels" as const,
      labels: {
        'priority "p0"': 0,
        "path \\ p1": 1,
      },
    };
    const markdown = generateWorkflowMarkdown({
      ...defaultInput,
      priority,
    });
    const parsed = parseWorkflowMarkdown(markdown, {});

    expect(markdown).toContain('"priority \\"p0\\"": 0');
    expect(markdown).toContain('"path \\\\ p1": 1');
    expect(parsed.tracker.priority).toEqual(priority);
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

    expect(markdown).toContain("kind: codex-app-server");
    expect(markdown).toContain("command: codex");
    expect(markdown).toContain("    - app-server");
  });

  it("resolves runtime config for claude-print", () => {
    const markdown = generateWorkflowMarkdown({
      ...defaultInput,
      runtime: "claude-print",
    });

    expect(markdown).toContain("kind: claude-print");
    expect(markdown).toContain("command: claude");
    expect(markdown).toContain("    - -p");
    expect(markdown).not.toContain("    env: ANTHROPIC_API_KEY");
    expect(markdown).toContain("    stall_timeout_ms: 900000");
  });

  it("prepends Claude runtime constraints and trade-off comments to the prompt body", () => {
    const markdown = generateWorkflowMarkdown({
      ...defaultInput,
      runtime: "claude-print",
    });
    const parsed = parseWorkflowMarkdown(markdown, {});

    expect(
      parsed.promptTemplate.startsWith(CLAUDE_RUNTIME_PROMPT_PREAMBLE)
    ).toBe(true);
    expect(parsed.promptTemplate).toContain(CLAUDE_RUNTIME_CONSTRAINTS_SECTION);
    expect(parsed.promptTemplate).toContain(
      "This run uses `claude-print` (Claude Code CLI) in non-interactive mode via `claude -p`."
    );
    expect(parsed.promptTemplate).toContain(CLAUDE_PERMISSIVE_ISOLATION_NOTE);
    expect(parsed.promptTemplate).toContain(CLAUDE_ISOLATION_OFF_NOTE);
    expect(parsed.promptTemplate).toContain("Runtime trade-off note:");
    expect(
      parsed.promptTemplate.indexOf("## Runtime Constraints")
    ).toBeLessThan(parsed.promptTemplate.indexOf("## Status Map"));
  });

  it("prepends Claude runtime constraints for legacy claude-code runtime aliases", () => {
    const markdown = generateWorkflowMarkdown({
      ...defaultInput,
      runtime: "claude-code",
    });
    const parsed = parseWorkflowMarkdown(markdown, {});

    expect(markdown).toContain("kind: claude-print");
    expect(
      parsed.promptTemplate.startsWith(CLAUDE_RUNTIME_PROMPT_PREAMBLE)
    ).toBe(true);
  });

  it("prepends Claude runtime constraints for wrapped claude-code commands", () => {
    const markdown = generateWorkflowMarkdown({
      ...defaultInput,
      runtime: "bash -lc claude-code",
    });
    const parsed = parseWorkflowMarkdown(markdown, {});

    expect(markdown).toContain("kind: custom");
    expect(markdown).toContain("command: bash -lc claude-code");
    expect(
      parsed.promptTemplate.startsWith(CLAUDE_RUNTIME_PROMPT_PREAMBLE)
    ).toBe(true);
  });

  it("keeps the Codex prompt body unchanged while Claude only adds the runtime preamble", () => {
    const codexMarkdown = generateWorkflowMarkdown(defaultInput);
    const claudeMarkdown = generateWorkflowMarkdown({
      ...defaultInput,
      runtime: "claude-print",
    });
    const codexPrompt = parseWorkflowMarkdown(codexMarkdown, {}).promptTemplate;
    const claudePrompt = parseWorkflowMarkdown(
      claudeMarkdown,
      {}
    ).promptTemplate;

    expect(codexPrompt.startsWith("## Status Map")).toBe(true);
    expect(codexPrompt).not.toContain("## Runtime Constraints");
    expect(codexPrompt).not.toContain("Permissive preset requires");
    expect(codexPrompt).not.toContain("Isolation is off by default");
    expect(claudePrompt).toBe(
      `${CLAUDE_RUNTIME_PROMPT_PREAMBLE}\n\n${codexPrompt}`
    );
  });

  it("uses custom runtime string as agent command", () => {
    const markdown = generateWorkflowMarkdown({
      ...defaultInput,
      runtime: "node worker.js",
    });
    const parsed = parseWorkflowMarkdown(markdown, {});

    expect(markdown).toContain("kind: custom");
    expect(markdown).toContain("command: node worker.js");
    expect(parsed.promptTemplate.startsWith("## Status Map")).toBe(true);
    expect(parsed.promptTemplate).not.toContain("## Runtime Constraints");
    expect(parsed.promptTemplate).not.toContain("Permissive preset requires");
    expect(parsed.promptTemplate).not.toContain("Isolation is off by default");
  });

  it("does not prepend Claude runtime constraints for substring-only custom runtime strings", () => {
    for (const runtime of ["my-claude-code-wrapper", "not-claude-code"]) {
      const markdown = generateWorkflowMarkdown({
        ...defaultInput,
        runtime,
      });
      const parsed = parseWorkflowMarkdown(markdown, {});

      expect(markdown).toContain("kind: custom");
      expect(markdown).toContain(`command: ${runtime}`);
      expect(parsed.promptTemplate.startsWith("## Status Map")).toBe(true);
      expect(parsed.promptTemplate).not.toContain("## Runtime Constraints");
      expect(parsed.promptTemplate).not.toContain("Runtime trade-off note:");
    }
  });

  it("points after_create at the scaffolded default hook path", () => {
    const markdown = generateWorkflowMarkdown(defaultInput);

    expect(markdown).toContain(
      `after_create: ${DEFAULT_AFTER_CREATE_HOOK_PATH}`
    );
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
