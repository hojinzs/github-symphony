import { describe, expect, it } from "vitest";
import { parseWorkflowMarkdown } from "@gh-symphony/core";
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
    repositories: [
      { owner: "acme", name: "platform" },
      { owner: "acme", name: "api" },
    ],
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

  it("includes allowed_repositories from input", () => {
    const markdown = generateWorkflowMarkdown(defaultInput);
    const parsed = parseWorkflowMarkdown(markdown, {});

    expect(parsed.allowedRepositories).toEqual([
      "acme/platform",
      "acme/api",
    ]);
  });

  it("uses custom poll interval when provided", () => {
    const markdown = generateWorkflowMarkdown({
      ...defaultInput,
      pollIntervalMs: 15000,
    });
    const parsed = parseWorkflowMarkdown(markdown, {});

    expect(parsed.scheduler.pollIntervalMs).toBe(15000);
  });

  it("resolves runtime agent command for codex", () => {
    const markdown = generateWorkflowMarkdown(defaultInput);

    expect(markdown).toContain("agent_command: bash -lc codex app-server");
  });

  it("resolves runtime agent command for claude-code", () => {
    const markdown = generateWorkflowMarkdown({
      ...defaultInput,
      runtime: "claude-code",
    });

    expect(markdown).toContain("agent_command: bash -lc claude-code");
  });

  it("uses custom runtime string as agent command", () => {
    const markdown = generateWorkflowMarkdown({
      ...defaultInput,
      runtime: "node worker.js",
    });

    expect(markdown).toContain("agent_command: node worker.js");
  });

  it("includes template variables that resolve without errors", () => {
    const markdown = generateWorkflowMarkdown(defaultInput);

    expect(markdown).toContain("{{issue.identifier}}");
    expect(markdown).toContain("{{issue.title}}");
    expect(markdown).toContain("{{issue.state}}");
    expect(markdown).toContain("{{issue.description}}");
    expect(markdown).toContain("{{issue.repository}}");
    expect(markdown).toContain("{{guidelines}}");
    // Must NOT include unsupported variables
    expect(markdown).not.toContain("{{issue.labels}}");
  });
});
