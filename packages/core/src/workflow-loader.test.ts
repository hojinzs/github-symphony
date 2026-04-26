import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowConfigStore } from "./workflow/loader.js";
import { parseWorkflowMarkdown } from "./workflow/parser.js";
import {
  resolveWorkflowRuntimeCommand,
  resolveWorkflowRuntimeTimeouts,
} from "./workflow/config.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0, tempDirs.length)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

const SAMPLE_WORKFLOW = `---
continuation_guidance: Continue from the latest state. Previous summary: {{lastTurnSummary}}
tracker:
  kind: github-project
  project_id: project-123
  state_field: Status
  priority_field: Priority
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
polling:
  interval_ms: 30000
workspace:
  root: .runtime/workspaces
hooks:
  after_create: hooks/after_create.sh
agent:
  max_retry_backoff_ms: 30000
  max_failure_retries: 6
  max_turns: 20
  max_concurrent_agents_by_state:
    Todo: 1
codex:
  command: codex app-server
  read_timeout_ms: 5000
  turn_timeout_ms: 3600000
custom_extension:
  enabled: true
---
Prefer focused changes.
`;

describe("parseWorkflowMarkdown", () => {
  it("parses spec-shaped yaml front matter and prompt body", () => {
    const workflow = parseWorkflowMarkdown(SAMPLE_WORKFLOW);

    expect(workflow).toMatchObject({
      githubProjectId: "project-123",
      promptTemplate: "Prefer focused changes.",
      continuationGuidance:
        "Continue from the latest state. Previous summary: {{lastTurnSummary}}",
      agentCommand: "codex app-server",
      hookPath: "hooks/after_create.sh",
      format: "front-matter",
    });
    expect(workflow.tracker.kind).toBe("github-project");
    expect(workflow.tracker.priorityFieldName).toBe("Priority");
    expect(workflow.polling.intervalMs).toBe(30000);
    expect(workflow.agent.maxFailureRetries).toBe(6);
    expect(workflow.agent.maxConcurrentAgentsByState).toEqual({ Todo: 1 });
  });

  it("defaults max_failure_retries to 10 when unset", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
codex:
  command: codex app-server
---
Prompt body.
`);

    expect(workflow.agent.maxFailureRetries).toBe(10);
  });

  it("resolves environment indirection from yaml front matter", () => {
    const workflow = parseWorkflowMarkdown(
      `---
tracker:
  kind: github-project
codex:
  command: \${TEST_AGENT_COMMAND}
---
Render with env indirection.
`,
      {
        TEST_AGENT_COMMAND: "custom-app-server",
      } as NodeJS.ProcessEnv
    );

    expect(workflow.agentCommand).toBe("custom-app-server");
  });

  it("parses runtime-only claude-print front matter", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
runtime:
  kind: claude-print
  command: claude
  args:
    - -p
    - --verbose
  isolation:
    bare: true
    strict_mcp_config: true
  auth:
    env: ANTHROPIC_API_KEY
  timeouts:
    read_timeout_ms: 7000
    turn_timeout_ms: 120000
    stall_timeout_ms: 60000
---
Prompt body.
`);

    expect(workflow.runtime).toEqual({
      kind: "claude-print",
      command: "claude",
      args: ["-p", "--verbose"],
      isolation: {
        bare: true,
        strictMcpConfig: true,
      },
      auth: {
        env: "ANTHROPIC_API_KEY",
      },
      timeouts: {
        readTimeoutMs: 7000,
        turnTimeoutMs: 120000,
        stallTimeoutMs: 60000,
      },
    });
    expect(workflow.agentCommand).toBe("claude -p --verbose");
    expect(workflow.codex.command).toBe("codex app-server");
    expect(resolveWorkflowRuntimeCommand(workflow)).toBe("claude -p --verbose");
    expect(resolveWorkflowRuntimeTimeouts(workflow).stallTimeoutMs).toBe(60000);
  });

  it("keeps legacy codex fallback without reverse-mapping a runtime", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
codex:
  command: claude -p --output-format stream-json
---
Prompt body.
`);

    expect(workflow.runtime).toBeNull();
    expect(workflow.codex.command).toBe("claude -p --output-format stream-json");
    expect(workflow.agentCommand).toBe("claude -p --output-format stream-json");
  });

  it("prefers runtime when runtime and legacy codex coexist", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
runtime:
  kind: custom
  command: node
  args: [worker.js, --flag]
codex:
  command: codex app-server
---
Prompt body.
`);

    expect(workflow.runtime).toMatchObject({
      kind: "custom",
      command: "node",
      args: ["worker.js", "--flag"],
    });
    expect(workflow.codex.command).toBe("codex app-server");
    expect(workflow.agentCommand).toBe("node worker.js --flag");
  });

  it("parses quoted inline array entries containing commas", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
runtime:
  kind: custom
  command: node
  args: ["worker, one.js", "--flag"]
---
Prompt body.
`);

    expect(workflow.runtime?.args).toEqual(["worker, one.js", "--flag"]);
    expect(workflow.agentCommand).toBe("node worker, one.js --flag");
  });

  it("rejects malformed inline arrays instead of silently accepting them", () => {
    expect(() =>
      parseWorkflowMarkdown(`---
tracker:
  kind: github-project
runtime:
  kind: custom
  command: node
  args: ["unterminated, --flag]
---
Prompt body.
`)
    ).toThrow(/inline array has an unterminated string/);
  });

  it("rejects unsupported runtime kind values", () => {
    expect(() =>
      parseWorkflowMarkdown(`---
tracker:
  kind: github-project
runtime:
  kind: unsupported-runtime
---
Prompt body.
`)
    ).toThrow(/Unsupported workflow runtime kind/);
  });

  it("does not expose session resume fields in runtime schema", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
runtime:
  kind: claude-print
  command: claude
  session:
    resume: true
---
Prompt body.
`);

    expect(workflow.runtime).not.toHaveProperty("session");
  });

  it("rejects old schema in strict mode", () => {
    expect(() =>
      parseWorkflowMarkdown(`---
runtime:
  agent_command: codex app-server
---
Old schema.
`)
    ).toThrow(/tracker/);
  });

  it("preserves multiline hook bodies", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
codex:
  command: codex app-server
hooks:
  before_run: |
    echo "hello"
    pwd
---
Prompt body.
`);

    expect(workflow.hooks.beforeRun).toBe('echo "hello"\npwd');
    expect(workflow.promptTemplate).toBe("Prompt body.");
  });

  it("preserves Liquid prompt syntax in the markdown body", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
codex:
  command: codex app-server
---
{% if issue.labels.size > 0 %}
Labels:
{% for label in issue.labels %}- {{ label | upcase }}
{% endfor %}
{% endif %}
`);

    expect(workflow.promptTemplate).toContain("{% if issue.labels.size > 0 %}");
    expect(workflow.promptTemplate).toContain("{{ label | upcase }}");
    expect(workflow.promptTemplate).toContain("{% endfor %}");
  });

  it("accepts camelCase continuation guidance in front matter", () => {
    const workflow = parseWorkflowMarkdown(`---
continuationGuidance: Continue from turn {{cumulativeTurnCount}}.
tracker:
  kind: github-project
codex:
  command: codex app-server
---
Prompt body.
`);

    expect(workflow.continuationGuidance).toBe(
      "Continue from turn {{cumulativeTurnCount}}."
    );
  });
});

describe("WorkflowConfigStore", () => {
  it("keeps the last known good workflow after an invalid update", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-loader-"));
    tempDirs.push(root);
    const workflowPath = join(root, "WORKFLOW.md");
    const store = new WorkflowConfigStore();

    await writeFile(workflowPath, SAMPLE_WORKFLOW, "utf8");

    const first = await store.load(workflowPath);
    await writeFile(
      workflowPath,
      `---
tracker:
  kind: github-project
codex:
  command:
---
Broken prompt.
`,
      "utf8"
    );

    const second = await store.load(workflowPath);

    expect(first.isValid).toBe(true);
    expect(second.promptTemplate).toBe("Prefer focused changes.");
    expect(second.isValid).toBe(false);
    expect(second.usedLastKnownGood).toBe(true);
    expect(second.validationError).toContain("command");
  });
});
