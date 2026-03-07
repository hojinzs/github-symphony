import { describe, expect, it } from "vitest";
import { resolveWorkspaceDirectory } from "./after-create-hook.js";
import { calculateRetryDelay, scheduleRetryAt } from "./retry-policy.js";
import { parseWorkflowMarkdown } from "./workflow-parser.js";
import { DEFAULT_WORKFLOW_LIFECYCLE } from "./workflow-lifecycle.js";

const SAMPLE_WORKFLOW = `# Symphony Workspace

## GitHub Project

- Project ID: project-123

## Prompt Guidelines

Prefer small changes and always explain risk.

## Repository Allowlist

- https://github.com/acme/platform.git
- https://github.com/acme/api.git

## Approval Lifecycle

- State field: Status
- Planning-active states:
  - Todo
  - Needs Plan
- Human-review states:
  - Human Review
- Implementation-active states:
  - Approved
  - Ready to Implement
- Awaiting-merge states:
  - Await Merge
- Completed states:
  - Done
- Planning complete -> Human Review
- Implementation complete -> Await Merge
- Merge complete -> Done

## Runtime

- Agent command: \`bash -lc codex app-server\`
- Hook: \`hooks/after_create.sh\`
`;

describe("Symphony core conformance", () => {
  it("parses a valid WORKFLOW.md contract", () => {
    expect(parseWorkflowMarkdown(SAMPLE_WORKFLOW)).toEqual({
      githubProjectId: "project-123",
      promptGuidelines: "Prefer small changes and always explain risk.",
      allowedRepositories: [
        "https://github.com/acme/platform.git",
        "https://github.com/acme/api.git"
      ],
      agentCommand: "bash -lc codex app-server",
      hookPath: "hooks/after_create.sh",
      lifecycle: DEFAULT_WORKFLOW_LIFECYCLE
    });
  });

  it("fails fast when WORKFLOW.md is missing required sections", () => {
    expect(() => parseWorkflowMarkdown("## Prompt Guidelines\n\nMissing everything else")).toThrow(
      "WORKFLOW.md is missing required content"
    );
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
