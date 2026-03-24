import {
  calculateRetryDelay,
  DEFAULT_WORKFLOW_LIFECYCLE,
  parseWorkflowMarkdown,
  resolveWorkspaceDirectory,
  scheduleRetryAt,
} from "@gh-symphony/core";
import { describe, expect, it } from "vitest";

const SAMPLE_WORKFLOW = `---
continuation_guidance: Resume using {{lastTurnSummary}}
tracker:
  kind: github-project
  project_id: project-123
  state_field: Status
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
  blocker_check_states:
    - Todo
polling:
  interval_ms: 30000
workspace:
  root: .runtime/workspaces
hooks:
  after_create: hooks/after_create.sh
agent:
  max_retry_backoff_ms: 30000
  max_turns: 20
codex:
  command: codex app-server
  read_timeout_ms: 5000
  turn_timeout_ms: 3600000
---
Prefer small changes and always explain risk.
`;

describe("Symphony core conformance", () => {
  it("parses a valid WORKFLOW.md contract", () => {
    expect(parseWorkflowMarkdown(SAMPLE_WORKFLOW)).toMatchObject({
      githubProjectId: "project-123",
      promptTemplate: "Prefer small changes and always explain risk.",
      continuationGuidance: "Resume using {{lastTurnSummary}}",
      agentCommand: "codex app-server",
      hookPath: "hooks/after_create.sh",
      lifecycle: DEFAULT_WORKFLOW_LIFECYCLE,
    });
  });

  it("rejects workflows without canonical front matter in strict mode", () => {
    expect(() =>
      parseWorkflowMarkdown("## Prompt Guidelines\n\nMissing everything else")
    ).toThrow(/YAML front matter/);
  });

  it("keeps workspace paths isolated under the configured root", () => {
    expect(
      resolveWorkspaceDirectory("/tmp/github-symphony", "workspace-1")
    ).toBe("/tmp/github-symphony/workspace-1");
  });

  it("applies exponential retry backoff with a deterministic schedule", () => {
    expect(
      calculateRetryDelay(4, { baseDelayMs: 1000, maxDelayMs: 30000 })
    ).toBe(8000);
    expect(
      scheduleRetryAt(new Date("2026-03-07T09:00:00.000Z"), 3, {
        baseDelayMs: 1000,
        maxDelayMs: 30000,
      }).toISOString()
    ).toBe("2026-03-07T09:00:04.000Z");
  });
});
