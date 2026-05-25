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
    expect(workflow.tracker.priority).toBeNull();
    expect(workflow.tracker.priorityFieldName).toBe("Priority");
    expect(workflow.lifecycle.blockerCheckStates).toEqual([]);
    expect(workflow.lifecycle.planningStates).toEqual([]);
    expect(workflow.polling.intervalMs).toBe(30000);
    expect(workflow.agent.maxFailureRetries).toBe(6);
    expect(workflow.agent.maxConcurrentAgentsByState).toEqual({ Todo: 1 });
  });

  it("falls planning states back to explicit blocker check states", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
  blocker_check_states:
    - Todo
codex:
  command: codex app-server
---
Prompt body.
`);

    expect(workflow.lifecycle.blockerCheckStates).toEqual(["Todo"]);
    expect(workflow.lifecycle.planningStates).toEqual(["Todo"]);
  });

  it("parses independent planning states", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
  blocker_check_states: []
  planning_states:
    - Todo
codex:
  command: codex app-server
---
Prompt body.
`);

    expect(workflow.lifecycle.blockerCheckStates).toEqual([]);
    expect(workflow.lifecycle.planningStates).toEqual(["Todo"]);
  });

  it("parses explicit project-field priority mapping", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
  priority:
    source: project-field
    field: Priority
    values:
      Urgent: 0
      High: 1
      Later: -1
codex:
  command: codex app-server
---
Prompt body.
`);

    expect(workflow.tracker.priority).toEqual({
      source: "project-field",
      field: "Priority",
      values: {
        Urgent: 0,
        High: 1,
        Later: -1,
      },
    });
  });

  it("parses explicit label priority mapping", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
  priority:
    source: labels
    labels:
      P0: 0
      P1: 1
codex:
  command: codex app-server
---
Prompt body.
`);

    expect(workflow.tracker.priority).toEqual({
      source: "labels",
      labels: {
        P0: 0,
        P1: 1,
      },
    });
  });

  it("parses generated priority comments and quoted mapping keys", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
  # Priority is explicit. Numbers below are editable policy.
  priority:
    source: labels
    labels:
      "priority: p0": 0
      "priority: p1": 1
codex:
  command: codex app-server
---
Prompt body.
`);

    expect(workflow.tracker.priority).toEqual({
      source: "labels",
      labels: {
        "priority: p0": 0,
        "priority: p1": 1,
      },
    });
  });

  it("unescapes quoted priority field and mapping names", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
  priority:
    source: project-field
    field: "Priority \\"dispatch\\" \\\\ team"
    values:
      "label \\"p0\\"": 0
      "path \\\\ p1": 1
      'single '' quote': 2
codex:
  command: codex app-server
---
Prompt body.
`);

    expect(workflow.tracker.priority).toEqual({
      source: "project-field",
      field: 'Priority "dispatch" \\ team',
      values: {
        'label "p0"': 0,
        "path \\ p1": 1,
        "single ' quote": 2,
      },
    });
  });

  it("parses disabled priority source without rejecting legacy priority_field", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
  priority_field: Priority
  priority:
    source: disabled
codex:
  command: codex app-server
---
Prompt body.
`);

    expect(workflow.tracker.priority).toEqual({ source: "disabled" });
    expect(workflow.tracker.priorityFieldName).toBe("Priority");
  });

  it.each([
    [
      "project-field without field",
      `priority:
    source: project-field
    values:
      P0: 0`,
      'Workflow front matter field "field" is required.',
    ],
    [
      "project-field without values",
      `priority:
    source: project-field
    field: Priority`,
      'Workflow front matter field "tracker.priority.values" must be a non-empty object for tracker.priority.source "project-field".',
    ],
    [
      "labels without labels",
      `priority:
    source: labels`,
      'Workflow front matter field "tracker.priority.labels" must be a non-empty object for tracker.priority.source "labels".',
    ],
    [
      "project-field with labels",
      `priority:
    source: project-field
    field: Priority
    values:
      P0: 0
    labels:
      P1: 1`,
      'Workflow front matter field "tracker.priority.labels" is not supported for tracker.priority.source "project-field".',
    ],
    [
      "labels with field",
      `priority:
    source: labels
    field: Priority
    labels:
      P0: 0`,
      'Workflow front matter field "tracker.priority.field" is not supported for tracker.priority.source "labels".',
    ],
    [
      "disabled with values",
      `priority:
    source: disabled
    values:
      P0: 0`,
      'Workflow front matter field "tracker.priority.values" is not supported for tracker.priority.source "disabled".',
    ],
    [
      "unknown source",
      `priority:
    source: project-labels
    labels:
      P0: 0`,
      'Unsupported workflow tracker.priority.source "project-labels". Supported values: project-field, labels, disabled.',
    ],
  ])("rejects invalid priority config: %s", (_name, priorityYaml, message) => {
    expect(() =>
      parseWorkflowMarkdown(`---
tracker:
  kind: github-project
  ${priorityYaml}
codex:
  command: codex app-server
---
Prompt body.
`)
    ).toThrow(message);
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

  it("parses Linear tracker config with default endpoint", () => {
    const workflow = parseWorkflowMarkdown(
      `---
tracker:
  kind: linear
  project_slug: symphony-0c79b11b75ea
  api_key: $LINEAR_API_KEY
  active_states:
    - Todo
    - In Progress
codex:
  command: codex app-server
---
Prompt body.
`,
      { LINEAR_API_KEY: "lin_api_key" } as NodeJS.ProcessEnv
    );

    expect(workflow.tracker.kind).toBe("linear");
    expect(workflow.tracker.projectSlug).toBe("symphony-0c79b11b75ea");
    expect(workflow.tracker.endpoint).toBe("https://api.linear.app/graphql");
    expect(workflow.tracker.apiKey).toBe("lin_api_key");
    expect(workflow.tracker.projectId).toBeNull();
  });

  it.each(["project_id", "projectId", "teamId", "team_id"])(
    "rejects Linear tracker alias %s",
    (key) => {
      expect(() =>
        parseWorkflowMarkdown(`---
tracker:
  kind: linear
  project_slug: symphony-0c79b11b75ea
  ${key}: forbidden
codex:
  command: codex app-server
---
Prompt body.
`)
      ).toThrow(
        `Workflow front matter field "tracker.${key}" is not supported for tracker.kind "linear"; use "tracker.project_slug".`
      );
    }
  );

  it("requires project_slug for Linear tracker config", () => {
    expect(() =>
      parseWorkflowMarkdown(`---
tracker:
  kind: linear
codex:
  command: codex app-server
---
Prompt body.
`)
    ).toThrow(
      'Workflow front matter field "tracker.project_slug" is required for tracker.kind "linear".'
    );
  });

  it("rejects blank project_slug for Linear tracker config", () => {
    expect(() =>
      parseWorkflowMarkdown(`---
tracker:
  kind: linear
  project_slug: ""
codex:
  command: codex app-server
---
Prompt body.
`)
    ).toThrow(
      'Workflow front matter field "tracker.project_slug" is required for tracker.kind "linear".'
    );
  });

  it("rejects blank endpoint for Linear tracker config", () => {
    expect(() =>
      parseWorkflowMarkdown(`---
tracker:
  kind: linear
  project_slug: symphony-0c79b11b75ea
  endpoint: ""
codex:
  command: codex app-server
---
Prompt body.
`)
    ).toThrow(
      'Workflow front matter field "tracker.endpoint" must be a non-empty string when provided for tracker.kind "linear".'
    );
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
    expect(workflow.codex.command).toBe(
      "claude -p --output-format stream-json"
    );
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

  it("reports trailing commas in inline arrays clearly", () => {
    expect(() =>
      parseWorkflowMarkdown(`---
tracker:
  kind: github-project
runtime:
  kind: custom
  command: node
  args: [worker.js, --flag,]
---
Prompt body.
`)
    ).toThrow(/inline array has a trailing comma/);
  });

  it("requires runtime args to be an array of strings", () => {
    expect(() =>
      parseWorkflowMarkdown(`---
tracker:
  kind: github-project
runtime:
  kind: custom
  command: node
  args: node,worker.js
---
Prompt body.
`)
    ).toThrow(
      /Workflow front matter field "runtime\.args" must be an array of strings/
    );
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

  it("rejects non-object runtime blocks clearly", () => {
    expect(() =>
      parseWorkflowMarkdown(`---
tracker:
  kind: github-project
runtime: false
codex:
  command: codex app-server
---
Prompt body.
`)
    ).toThrow(/Workflow front matter field "runtime" must be an object/);
  });

  it("reports nested runtime object paths clearly", () => {
    expect(() =>
      parseWorkflowMarkdown(`---
tracker:
  kind: github-project
runtime:
  kind: claude-print
  isolation: false
---
Prompt body.
`)
    ).toThrow(
      /Workflow front matter field "runtime\.isolation" must be an object/
    );
  });

  it("reports nested runtime boolean paths clearly", () => {
    expect(() =>
      parseWorkflowMarkdown(`---
tracker:
  kind: github-project
runtime:
  kind: claude-print
  isolation:
    bare: "yes"
---
Prompt body.
`)
    ).toThrow(
      /Workflow front matter field "runtime\.isolation\.bare" must be a boolean/
    );
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

  it("does not expose runtime session controls from WORKFLOW.md", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
runtime:
  kind: claude-print
  session:
    resume: true
codex:
  command: codex app-server
---
Prompt body.
`);

    expect(workflow.runtime?.kind).toBe("claude-print");
    expect("session" in (workflow.runtime as Record<string, unknown>)).toBe(
      false
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
