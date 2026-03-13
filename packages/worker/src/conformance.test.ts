import {
  calculateRetryDelay,
  DEFAULT_WORKFLOW_LIFECYCLE,
  parseWorkflowMarkdown,
  resolveWorkspaceDirectory,
  scheduleRetryAt
} from "@gh-symphony/core";
import { describe, expect, it } from "vitest";

const SAMPLE_WORKFLOW = `---
github_project_id: project-123
allowed_repositories:
  - https://github.com/acme/platform.git
  - https://github.com/acme/api.git
lifecycle:
  state_field: Status
  planning_active:
    - Todo
  human_review:
    - Plan Review
  implementation_active:
    - In Progress
  awaiting_merge:
    - In Review
  completed:
    - Done
  transitions:
    planning_complete: Plan Review
    implementation_complete: In Review
    merge_complete: Done
runtime:
  agent_command: bash -lc codex app-server
hooks:
  after_create: hooks/after_create.sh
---
Prefer small changes and always explain risk.
`;

describe("Symphony core conformance", () => {
  it("parses a valid WORKFLOW.md contract", () => {
    expect(parseWorkflowMarkdown(SAMPLE_WORKFLOW)).toMatchObject({
      githubProjectId: "project-123",
      promptTemplate: "Prefer small changes and always explain risk.",
      allowedRepositories: [
        "https://github.com/acme/platform.git",
        "https://github.com/acme/api.git"
      ],
      agentCommand: "bash -lc codex app-server",
      hookPath: "hooks/after_create.sh",
      lifecycle: DEFAULT_WORKFLOW_LIFECYCLE
    });
  });

  it("falls back to default lifecycle semantics when sections are omitted", () => {
    expect(parseWorkflowMarkdown("## Prompt Guidelines\n\nMissing everything else")).toMatchObject({
      githubProjectId: null,
      promptTemplate: "Missing everything else",
      allowedRepositories: [],
      agentCommand: "bash -lc codex app-server",
      hookPath: "hooks/after_create.sh",
      lifecycle: DEFAULT_WORKFLOW_LIFECYCLE
    });
  });

  it("keeps workspace paths isolated under the configured root", () => {
    expect(resolveWorkspaceDirectory("/tmp/github-symphony", "workspace-1")).toBe(
      "/tmp/github-symphony/workspace-1"
    );
  });

  it("applies exponential retry backoff with a deterministic schedule", () => {
    expect(calculateRetryDelay(4, { baseDelayMs: 1000, maxDelayMs: 30000 })).toBe(8000);
    expect(
      scheduleRetryAt(new Date("2026-03-07T09:00:00.000Z"), 3, {
        baseDelayMs: 1000,
        maxDelayMs: 30000
      }).toISOString()
    ).toBe("2026-03-07T09:00:04.000Z");
  });
});
