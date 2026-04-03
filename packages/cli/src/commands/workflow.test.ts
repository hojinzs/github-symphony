import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import workflowCommand from "./workflow.js";

function captureWrites(stream: NodeJS.WriteStream): {
  output: () => string;
  restore: () => void;
} {
  let buffer = "";
  const spy = vi.spyOn(stream, "write").mockImplementation(((
    chunk: string | Uint8Array
  ) => {
    buffer +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof stream.write);

  return {
    output: () => buffer,
    restore: () => spy.mockRestore(),
  };
}

const SAMPLE_WORKFLOW = `---
continuation_guidance: Continue after {{ cumulativeTurnCount }} turns. Summary: {{ lastTurnSummary }}
tracker:
  kind: github-project
  project_id: project-123
  state_field: Status
  active_states:
    - Ready
    - In progress
  terminal_states:
    - Done
codex:
  command: codex app-server
---
# Issue
{{ issue.identifier }}: {{ issue.title }}

Attempt={{ attempt }}
Labels={% for label in issue.labels %}{{ label }} {% endfor %}
`;

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("workflow command handler", () => {
  it("validates a workflow file with strict prompt and continuation rendering", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-validate-"));
    const workflowPath = join(root, "WORKFLOW.md");
    const stdout = captureWrites(process.stdout);

    await writeFile(workflowPath, SAMPLE_WORKFLOW, "utf8");

    try {
      await workflowCommand(["validate", "--file", workflowPath], {
        configDir: root,
        verbose: false,
        json: false,
        noColor: false,
      });
    } finally {
      stdout.restore();
    }

    expect(stdout.output()).toContain("WORKFLOW.md validation passed");
    expect(stdout.output()).toContain(`Path: ${workflowPath}`);
    expect(stdout.output()).toContain("continuation_guidance=pass");
    expect(stdout.output()).toContain("active_states=Ready, In progress");
  });

  it("previews a workflow with the built-in sample issue", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-preview-"));
    const workflowPath = join(root, "WORKFLOW.md");
    const stdout = captureWrites(process.stdout);

    await writeFile(workflowPath, SAMPLE_WORKFLOW, "utf8");

    try {
      await workflowCommand(
        ["preview", "--file", workflowPath, "--attempt", "2"],
        {
          configDir: root,
          verbose: false,
          json: false,
          noColor: false,
        }
      );
    } finally {
      stdout.restore();
    }

    expect(stdout.output()).toContain("WORKFLOW.md prompt preview");
    expect(stdout.output()).toContain("Attempt: 2");
    expect(stdout.output()).toContain(
      "octo/hello-world#157: Add workflow validate and preview commands"
    );
    expect(stdout.output()).toContain("Attempt=2");
  });

  it("loads sample issue JSON for preview rendering", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-preview-sample-"));
    const workflowPath = join(root, "WORKFLOW.md");
    const samplePath = join(root, "sample-issue.json");
    const stdout = captureWrites(process.stdout);

    await writeFile(workflowPath, SAMPLE_WORKFLOW, "utf8");
    await writeFile(
      samplePath,
      JSON.stringify({
        id: "sample-1",
        identifier: "acme/api#9",
        number: 9,
        title: "Fix preview rendering",
        description: "Preview should use sample issue payloads.",
        state: "Ready",
        labels: ["bug"],
        blocked_by: [],
        repository: {
          owner: "acme",
          name: "api",
        },
      }),
      "utf8"
    );

    try {
      await workflowCommand(
        [
          "preview",
          "--file",
          workflowPath,
          "--sample",
          samplePath,
          "--attempt",
          "3",
        ],
        {
          configDir: root,
          verbose: false,
          json: false,
          noColor: false,
        }
      );
    } finally {
      stdout.restore();
    }

    expect(stdout.output()).toContain(`Sample: ${samplePath}`);
    expect(stdout.output()).toContain("acme/api#9: Fix preview rendering");
    expect(stdout.output()).toContain("Attempt=3");
  });
});
