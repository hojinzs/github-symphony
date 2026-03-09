import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowConfigStore } from "./workflow/loader.js";
import { parseWorkflowMarkdown } from "./workflow/parser.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((path) =>
      rm(path, { recursive: true, force: true })
    )
  );
});

describe("parseWorkflowMarkdown", () => {
  it("parses yaml front matter and prompt body", () => {
    const workflow = parseWorkflowMarkdown(`---
github_project_id: project-123
allowed_repositories:
  - https://github.com/acme/platform.git
runtime:
  agent_command: bash -lc codex app-server
hooks:
  after_create: hooks/after_create.sh
lifecycle:
  state_field: Status
  planning_active:
    - Needs Plan
  human_review:
    - Human Review
  implementation_active:
    - Approved
  awaiting_merge:
    - Await Merge
  completed:
    - Done
  transitions:
    planning_complete: Human Review
    implementation_complete: Await Merge
    merge_complete: Done
---
Prefer focused changes.
`);

    expect(workflow).toMatchObject({
      githubProjectId: "project-123",
      promptTemplate: "Prefer focused changes.",
      promptGuidelines: "Prefer focused changes.",
      allowedRepositories: ["https://github.com/acme/platform.git"],
      agentCommand: "bash -lc codex app-server",
      hookPath: "hooks/after_create.sh",
      format: "front-matter"
    });
  });

  it("resolves environment indirection from yaml front matter", () => {
    const workflow = parseWorkflowMarkdown(
      `---
runtime:
  agent_command: \${TEST_AGENT_COMMAND}
---
Render with env indirection.
`,
      {
        TEST_AGENT_COMMAND: "bash -lc custom-app-server"
      } as NodeJS.ProcessEnv
    );

    expect(workflow.agentCommand).toBe("bash -lc custom-app-server");
  });
});

describe("WorkflowConfigStore", () => {
  it("keeps the last known good workflow after an invalid update", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-loader-"));
    tempDirs.push(root);
    const workflowPath = join(root, "WORKFLOW.md");
    const store = new WorkflowConfigStore();

    await writeFile(
      workflowPath,
      `---
runtime:
  agent_command: bash -lc codex app-server
---
Initial prompt.
`,
      "utf8"
    );

    const first = await store.load(workflowPath);
    await writeFile(
      workflowPath,
      `---
runtime:
  agent_command:
---
Broken prompt.
`,
      "utf8"
    );

    const second = await store.load(workflowPath);

    expect(first.promptTemplate).toBe("Initial prompt.");
    expect(second.promptTemplate).toBe("Initial prompt.");
    expect(second.usedLastKnownGood).toBe(true);
    expect(second.validationError).toContain("agent_command");
  });
});
