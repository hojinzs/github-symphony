import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkflowConfigStore } from "./workflow/loader.js";
import {
  parseWorkflowMarkdown as parseProductionWorkflowMarkdown,
  parseWorkflowMarkdownForMigration,
  WorkflowValidationError,
} from "./workflow/parser.js";
import { isStateActive } from "./workflow/lifecycle.js";
import {
  resolveWorkflowRuntimeCommand,
  resolveWorkflowRuntimeTimeouts,
} from "./workflow/config.js";
import { calculateWorkflowVersionHash } from "./workflow/loader.js";

const tempDirs: string[] = [];

const testAdapter = {
  defaultLifecycle: () => ({
    stateFieldName: "Status",
    activeStates: ["Todo", "In Progress"],
    terminalStates: ["Done"],
    blockerCheckStates: ["Todo"],
    planningStates: [],
  }),
};

function parseWorkflowMarkdown(
  markdown: string,
  env?: NodeJS.ProcessEnv,
  options: Parameters<typeof parseProductionWorkflowMarkdown>[2] = {}
) {
  return parseProductionWorkflowMarkdown(markdown, env, {
    ...options,
    trackerAdapter: options.trackerAdapter ?? testAdapter,
  });
}

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
  provider:
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
repository:
  owner: acme
  name: platform
  extension_flag: true
---
Prefer focused changes.
`;

describe("parseWorkflowMarkdown", () => {
  it("rejects every removed flat tracker key with migration guidance", () => {
    expect(() =>
      parseProductionWorkflowMarkdown(`---
tracker:
  kind: github-project
  api_key: $TRACKER_TOKEN
  project_slug: platform
  project_id: PVT_test
  endpoint: https://example.test/graphql
  state_field: Status
  priority:
    source: disabled
  priority_field: Priority
  pickup_labels: { include: [agent] }
  blocker_check_states: [Ready]
  planning_states: [Plan]
---
Prompt`)
    ).toThrow(
      expect.objectContaining({
        code: "workflow_deprecated_key",
        path: "tracker.api_key",
        message: expect.stringContaining("tracker.provider"),
      })
    );
  });

  it("rejects an explicitly null removed flat tracker key", () => {
    expect(() =>
      parseProductionWorkflowMarkdown(`---
tracker:
  kind: github-project
  state_field: null
  provider:
    project_id: PVT_test
    state_field: Status
---
Prompt`)
    ).toThrow(
      expect.objectContaining({
        code: "workflow_deprecated_key",
        path: "tracker.state_field",
      })
    );
  });

  it("treats a front-matter-free workflow as its prompt with default config", () => {
    const workflow = parseWorkflowMarkdown(
      "\r\n# Agent instructions\r\n\r\nWork carefully.\r\n"
    );

    expect(workflow).toMatchObject({
      promptTemplate: "# Agent instructions\r\n\r\nWork carefully.",
      tracker: { kind: null },
      codex: { command: "codex app-server" },
      format: "front-matter",
    });
  });

  it("accepts CRLF front matter and normalizes workspace.root from WORKFLOW.md", () => {
    const workflow = parseWorkflowMarkdown(
      "---\r\nworkspace:\r\n  root: ~/workspaces\r\n---\r\nPrompt\r\n",
      {},
      {
        workflowPath: "/projects/example/.config/WORKFLOW.md",
        homeDir: "/home/agent",
      }
    );

    expect(workflow.workspace.root).toBe("/home/agent/workspaces");
  });

  it("resolves relative workspace.root values from the workflow directory", () => {
    const workflow = parseWorkflowMarkdown(
      "---\nworkspace:\n  root: ../shared-workspaces\n---\nPrompt",
      {},
      { workflowPath: "/projects/example/.config/WORKFLOW.md" }
    );

    expect(workflow.workspace.root).toBe("/projects/example/shared-workspaces");
  });

  it("expands lowercase environment variables only in workspace paths", () => {
    const workflow = parseWorkflowMarkdown(
      `---
workspace:
  root: $workspace_dir/checkouts
hooks:
  before_run: echo $workspace_dir ${"${workspace_dir}"}
codex:
  command: runner $workspace_dir ${"${workspace_dir}"}
---
Prompt`,
      { workspace_dir: "/var/lib/symphony" },
      { workflowPath: "/projects/example/WORKFLOW.md" }
    );

    expect(workflow.workspace.root).toBe("/var/lib/symphony/checkouts");
    expect(workflow.hooks.beforeRun).toBe(
      "echo $workspace_dir ${workspace_dir}"
    );
    expect(workflow.codex.command).toBe(
      "runner $workspace_dir ${workspace_dir}"
    );
  });

  it("reports a missing secret at the individual secret field", () => {
    let thrown: unknown;
    try {
      parseWorkflowMarkdown(
        `---
tracker:
  kind: github-project
  provider:
    api_key: env:missing_token
---
Prompt`,
        {}
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "workflow_validation_error",
      path: "tracker.provider.api_key",
    });
  });

  it.each([
    [
      "invalid YAML",
      "---\ntracker:\n   kind: github-project\n---\nPrompt",
      "workflow_parse_error",
      "front_matter",
    ],
    [
      "non-map front matter",
      "---\n- tracker\n---\nPrompt",
      "workflow_front_matter_not_a_map",
      "front_matter",
    ],
    [
      "scalar front matter",
      "---\nhello\n---\nPrompt",
      "workflow_front_matter_not_a_map",
      "front_matter",
    ],
    [
      "unsupported tracker",
      "---\ntracker:\n  kind: jira\ncodex:\n  command: codex\n---\nPrompt",
      "workflow_validation_error",
      "tracker.kind",
    ],
    [
      "string integer",
      "---\ntracker:\n  kind: github-project\nagent:\n  max_turns: '2'\ncodex:\n  command: codex\n---\nPrompt",
      "workflow_validation_error",
      "agent.max_turns",
    ],
    [
      "non-positive hook timeout",
      "---\ntracker:\n  kind: github-project\nhooks:\n  timeout_ms: 0\ncodex:\n  command: codex\n---\nPrompt",
      "workflow_validation_error",
      "hooks.timeout_ms",
    ],
    [
      "non-positive turn limit",
      "---\ntracker:\n  kind: github-project\nagent:\n  max_turns: -1\ncodex:\n  command: codex\n---\nPrompt",
      "workflow_validation_error",
      "agent.max_turns",
    ],
    [
      "non-positive global concurrency",
      "---\ntracker:\n  kind: github-project\nagent:\n  max_concurrent_agents: 0\ncodex:\n  command: codex\n---\nPrompt",
      "workflow_validation_error",
      "agent.max_concurrent_agents",
    ],
    [
      "empty codex command",
      "---\ntracker:\n  kind: github-project\ncodex:\n  command: '   '\n---\nPrompt",
      "workflow_validation_error",
      "codex.command",
    ],
  ])("returns a typed error for %s", (_name, markdown, code, path) => {
    try {
      parseWorkflowMarkdown(markdown);
      throw new Error("Expected parsing to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowValidationError);
      expect(error).toMatchObject({ code, path });
    }
  });

  it("applies defaults and normalizes per-state concurrency map keys", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
agent:
  max_concurrent_agents_by_state:
    " Ready ": 2
codex:
  command: codex
---
Prompt`);

    expect(workflow.hooks.timeoutMs).toBeGreaterThan(0);
    expect(workflow.agent.maxTurns).toBeGreaterThan(0);
    expect(workflow.agent.maxConcurrentAgentsByState).toEqual({ ready: 2 });
  });

  it("parses the optional HTTP server port", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
server:
  port: 0
codex:
  command: codex
---
Prompt`);

    expect(workflow.server.port).toBe(0);
  });

  it.each([-1, 65536, "'4680'"])(
    "rejects invalid server.port values",
    (port) => {
      expect(() =>
        parseWorkflowMarkdown(`---
tracker:
  kind: github-project
server:
  port: ${port}
codex:
  command: codex
---
Prompt`)
      ).toThrow(/server.port/);
    }
  );

  it("accepts tracker kinds injected by the adapter boundary", () => {
    const workflow = parseWorkflowMarkdown(
      `---
tracker:
  kind: custom-tracker
codex:
  command: codex
---
Prompt`,
      process.env,
      { supportedTrackerKinds: ["custom-tracker"] }
    );

    expect(workflow.tracker.kind).toBe("custom-tracker");
  });

  it("preserves provider-owned keys and delegates validation to the selected adapter", () => {
    const validateProviderConfig = vi.fn(() => []);
    const workflow = parseWorkflowMarkdown(
      `---
tracker:
  kind: custom-tracker
  provider:
    tenant: acme
    nested:
      enabled: true
    state_field: Workflow
  active_states:
    - Queued
  terminal_states:
    - Closed
codex:
  command: codex
---
Prompt`,
      process.env,
      {
        supportedTrackerKinds: ["custom-tracker"],
        trackerAdapter: { validateProviderConfig },
      }
    );

    expect(workflow.tracker.provider).toEqual({
      tenant: "acme",
      nested: { enabled: true },
      state_field: "Workflow",
    });
    expect(validateProviderConfig).toHaveBeenCalledWith(
      workflow.tracker.provider,
      { rawProvider: workflow.tracker.provider }
    );
  });

  it("resolves provider values before adapter validation", () => {
    const validateProviderConfig = vi.fn(() => []);
    parseWorkflowMarkdown(
      `---
tracker:
  kind: custom-tracker
  provider:
    endpoint: $GHES_URL
codex:
  command: codex
---
Prompt`,
      { GHES_URL: "https://github.example/api/graphql" },
      {
        supportedTrackerKinds: ["custom-tracker"],
        trackerAdapter: { validateProviderConfig },
      }
    );

    expect(validateProviderConfig).toHaveBeenCalledWith(
      { endpoint: "https://github.example/api/graphql" },
      { rawProvider: { endpoint: "$GHES_URL" } }
    );
  });

  it("accepts empty front matter as an empty configuration", () => {
    const workflow = parseWorkflowMarkdown("---\r\n---\r\nPrompt only");

    expect(workflow).toMatchObject({
      promptTemplate: "Prompt only",
      tracker: { kind: null },
    });
  });

  it("resolves provider validation and lifecycle defaults from tracker.kind", () => {
    const selectedAdapter = {
      validateProviderConfig: vi.fn(() => []),
      defaultLifecycle: () => ({
        stateFieldName: "Workflow",
        activeStates: ["Queued"],
        terminalStates: ["Closed"],
        blockerCheckStates: ["Queued"],
        planningStates: [],
      }),
    };
    const resolveTrackerAdapter = vi.fn((kind: string) =>
      kind === "custom-tracker" ? selectedAdapter : undefined
    );

    const workflow = parseWorkflowMarkdownForMigration(
      `---
tracker:
  kind: custom-tracker
  provider:
    tenant: acme
codex:
  command: codex
---
Prompt`,
      process.env,
      {
        supportedTrackerKinds: ["custom-tracker"],
        resolveTrackerAdapter,
      }
    );

    expect(resolveTrackerAdapter).toHaveBeenCalledWith("custom-tracker");
    expect(selectedAdapter.validateProviderConfig).toHaveBeenCalledWith(
      {
        tenant: "acme",
      },
      { rawProvider: { tenant: "acme" } }
    );
    expect(workflow.lifecycle).toMatchObject({
      stateFieldName: "Workflow",
      activeStates: ["Queued"],
      terminalStates: ["Closed"],
      planningStates: [],
    });
    expect(workflow.tracker.blockerCheckStates).toEqual(["Queued"]);
  });

  it("promotes flat tracker keys while retaining provider-owned values", () => {
    const workflow = parseWorkflowMarkdownForMigration(
      `---
tracker:
  kind: github-project
  provider:
    endpoint: https://provider.example.test/graphql
    custom_setting: retained
  api_key: $TRACKER_TOKEN
  endpoint: https://deprecated.example.test/graphql
  project_slug: platform
  active_states:
    - Ready
  terminal_states:
    - Done
  state_field: Status
codex:
  command: codex
---
Prompt`,
      { TRACKER_TOKEN: "token" } as NodeJS.ProcessEnv
    );

    expect(workflow.tracker.provider).toMatchObject({
      api_key: "$TRACKER_TOKEN",
      endpoint: "https://provider.example.test/graphql",
      project_slug: "platform",
      custom_setting: "retained",
    });
    expect(workflow.tracker.deprecatedKeys).toEqual([
      "api_key",
      "project_slug",
      "endpoint",
      "state_field",
    ]);
    expect(workflow.tracker.apiKey).toBe("token");
    expect(workflow.tracker.endpoint).toBe(
      "https://provider.example.test/graphql"
    );
  });

  it("projects provider aliases onto compatibility fields", () => {
    const workflow = parseWorkflowMarkdown(
      `---
tracker:
  kind: github-project
  provider:
    project_id: project-123
    api_key: $TRACKER_TOKEN
    endpoint: https://provider.example.test/graphql
    state_field: Status
  active_states: [Ready]
  terminal_states: [Done]
codex:
  command: codex
---
Prompt`,
      { TRACKER_TOKEN: "token" } as NodeJS.ProcessEnv
    );

    expect(workflow.tracker).toMatchObject({
      projectId: "project-123",
      apiKey: "token",
      endpoint: "https://provider.example.test/graphql",
    });
  });

  it("keeps resolved provider secrets private and resolves them once", () => {
    const validateProviderConfig = vi.fn(() => []);
    const workflow = parseWorkflowMarkdown(
      `---
tracker:
  kind: custom-tracker
  provider:
    api_key: env:TRACKER_TOKEN
    state_field: Cost $USD
codex:
  command: codex
---
Prompt`,
      { TRACKER_TOKEN: "abc$def" },
      {
        supportedTrackerKinds: ["custom-tracker"],
        trackerAdapter: { validateProviderConfig },
      }
    );

    expect(workflow.tracker.provider).toMatchObject({
      api_key: "env:TRACKER_TOKEN",
      state_field: "Cost $USD",
    });
    expect(workflow.tracker.apiKey).toBe("abc$def");
    expect(workflow.tracker.stateFieldName).toBe("Cost $USD");
    expect(validateProviderConfig).toHaveBeenCalledWith(
      {
        api_key: "abc$def",
        state_field: "Cost $USD",
      },
      {
        rawProvider: {
          api_key: "env:TRACKER_TOKEN",
          state_field: "Cost $USD",
        },
      }
    );
  });

  it("uses provider values consistently when deprecated flat keys coexist", () => {
    const workflow = parseWorkflowMarkdownForMigration(`---
tracker:
  kind: linear
  project_id: flat-project
  api_key: flat-key
  endpoint: https://flat.example.test
  state_field: Flat state
  active_states: [Todo]
  terminal_states: [Done]
  provider:
    project_id: provider-project
    api_key: provider-key
    endpoint: https://provider.example.test
    state_field: Provider state
codex:
  command: codex
---
Prompt`);

    expect(workflow.tracker).toMatchObject({
      projectId: "provider-project",
      apiKey: "provider-key",
      endpoint: "https://provider.example.test",
      stateFieldName: "Provider state",
      deprecatedKeys: ["api_key", "project_id", "endpoint", "state_field"],
    });
  });

  it("projects provider lifecycle and policy aliases", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
  provider:
    state_field: Workflow
    active_states: [Provider ready]
    terminal_states: [Provider done]
    pickup_labels:
      include: agent, dev-ready
    priority:
      source: labels
      labels:
        urgent: 0
    blocker_check_states: Ready, In progress
    planning_states:
      - Backlog
  active_states: [Flat ready]
  terminal_states: [Flat done]
codex:
  command: codex
---
Prompt`);

    expect(workflow.tracker).toMatchObject({
      stateFieldName: "Workflow",
      activeStates: ["Provider ready"],
      terminalStates: ["Provider done"],
      pickupLabels: { include: ["agent", "dev-ready"], exclude: [] },
      priority: { source: "labels", labels: { urgent: 0 } },
      blockerCheckStates: ["Ready", "In progress"],
      planningStates: ["Backlog"],
    });
  });

  it("keeps provider-only lifecycle configuration usable without an adapter", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
  provider:
    state_field: Workflow
  active_states: [Ready]
  terminal_states: [Done]
codex:
  command: codex
---
Prompt`);

    expect(workflow.lifecycle.stateFieldName).toBe("Workflow");
  });

  it("reports every adapter provider validation error", () => {
    const errors = [
      new WorkflowValidationError(
        "workflow_validation_error",
        "tracker.provider.project",
        "project is required."
      ),
      new WorkflowValidationError(
        "workflow_validation_error",
        "tracker.provider.token",
        "token is required."
      ),
    ];
    expect(() =>
      parseWorkflowMarkdown(
        `---
tracker:
  kind: github-project
  active_states: [Ready]
  terminal_states: [Done]
  provider:
    state_field: Status
codex:
  command: codex
---
Prompt`,
        process.env,
        { trackerAdapter: { validateProviderConfig: () => errors } }
      )
    ).toThrow(
      /project is required\. \(1 additional provider validation error: token is required\.\)/
    );
  });

  it("loads the bundled Linear example with deprecated lifecycle defaults", async () => {
    const markdown = await readFile(
      new URL("../../../docs/examples/linear-WORKFLOW.md", import.meta.url),
      "utf8"
    );
    const workflow = parseWorkflowMarkdown(markdown, {
      LINEAR_API_KEY: "test-key",
    } as NodeJS.ProcessEnv);

    expect(workflow.lifecycle).toMatchObject({ stateFieldName: "Status" });
    expect(workflow.tracker.projectSlug).toBe("symphony-0c79b11b75ea");
  });

  it("preserves lifecycle defaults until adapters provide their own", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
codex:
  command: codex
---
Prompt`);

    expect(workflow.lifecycle).toMatchObject({
      stateFieldName: "Status",
      activeStates: ["Todo", "In Progress"],
      terminalStates: ["Done"],
    });
  });

  it("uses lifecycle defaults for legacy sectioned workflows", () => {
    const workflow = parseWorkflowMarkdown(
      "## Prompt Guidelines\n\nPrompt",
      process.env,
      {
        compatibilityMode: "legacy",
      }
    );

    expect(workflow.lifecycle).toMatchObject({
      stateFieldName: "Status",
      activeStates: ["Todo", "In Progress"],
      terminalStates: ["Done"],
    });
  });

  it.each([
    ["active_states", "Ready, In progress", ["Done"]],
    ["terminal_states", ["Ready"], "Done, Cancelled"],
  ])(
    "rejects comma-separated %s values",
    (key, activeStates, terminalStates) => {
      expect(() =>
        parseWorkflowMarkdown(`---
tracker:
  kind: github-project
  provider:
    state_field: Status
  active_states: ${Array.isArray(activeStates) ? "[Ready]" : activeStates}
  terminal_states: ${Array.isArray(terminalStates) ? "[Done]" : terminalStates}
codex:
  command: codex
---
Prompt`)
      ).toThrow(`"${key}"`);
    }
  );

  it("keeps migration-parser errors on the provider path", () => {
    let thrown: unknown;
    try {
      parseWorkflowMarkdownForMigration(
        `---
tracker:
  kind: linear
  api_key: $MISSING_TRACKER_TOKEN
codex:
  command: codex
---
Prompt`,
        {}
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({ path: "tracker.provider.api_key" });
  });

  it("ignores invalid per-state concurrency overrides", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
agent:
  max_concurrent_agents_by_state:
    Ready: -1
    Waiting: 0
    Review: '2'
    Done: 1.5
    " In Progress ": 2
codex:
  command: codex
---
Prompt`);
    expect(workflow.agent.maxConcurrentAgentsByState).toEqual({
      "in progress": 2,
    });
    expect(workflow.diagnostics).toEqual([
      expect.objectContaining({
        path: "agent.max_concurrent_agents_by_state.Ready",
        reason: "must be greater than zero",
      }),
      expect.objectContaining({
        path: "agent.max_concurrent_agents_by_state.Waiting",
        reason: "must be greater than zero",
      }),
      expect.objectContaining({
        path: "agent.max_concurrent_agents_by_state.Review",
        reason: "must be a positive YAML integer",
      }),
      expect.objectContaining({
        path: "agent.max_concurrent_agents_by_state.Done",
        reason: "must be a positive YAML integer",
      }),
    ]);
  });

  it("warns about blank and colliding per-state concurrency entries", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
agent:
  max_concurrent_agents_by_state:
    Ready: 1
    " READY ": 2
    "  ": 3
codex:
  command: codex
---
Prompt`);

    expect(workflow.agent.maxConcurrentAgentsByState).toEqual({ ready: 2 });
    expect(workflow.diagnostics).toEqual([
      expect.objectContaining({
        code: "state_concurrency_entry_ignored",
        path: "agent.max_concurrent_agents_by_state.Ready",
        reason:
          'duplicates agent.max_concurrent_agents_by_state[" READY "] after state-name normalization',
      }),
      expect.objectContaining({
        code: "state_concurrency_entry_ignored",
        path: 'agent.max_concurrent_agents_by_state["  "]',
        reason: "state name is blank after normalization",
      }),
    ]);
  });

  it("excludes derived diagnostics from the workflow version hash", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
codex:
  command: codex
---
Prompt`);

    expect(
      calculateWorkflowVersionHash({
        ...workflow,
        diagnostics: [
          {
            code: "state_concurrency_entry_ignored",
            path: "agent.max_concurrent_agents_by_state.Ready",
            reason: "must be greater than zero",
            remediation: "Use a whole number greater than zero.",
          },
        ],
      })
    ).toBe(calculateWorkflowVersionHash(workflow));
  });

  it("preserves the path for an unresolved environment-backed workspace root", () => {
    let thrown: unknown;
    try {
      parseWorkflowMarkdown(
        `---
tracker:
  kind: github-project
workspace:
  root: ${"${UNSET_WORKSPACE_ROOT}"}
---
Prompt`,
        {}
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: "workflow_validation_error",
      path: "workspace.root",
    });
  });

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
    expect(workflow.tracker.blockerCheckStates).toEqual(["Todo"]);
    expect(workflow.lifecycle.planningStates).toEqual([]);
    expect(workflow.polling.intervalMs).toBe(30000);
    expect(workflow.repository).toEqual({
      owner: "acme",
      name: "platform",
      extension_flag: true,
    });
    expect(workflow.agent.maxFailureRetries).toBe(6);
    expect(workflow.agent.maxConcurrentAgentsByState).toEqual({ todo: 1 });
  });

  it("keeps planning disabled when blocker states are explicit", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
  provider:
    blocker_check_states:
      - Todo
codex:
  command: codex app-server
---
Prompt body.
`);

    expect(workflow.tracker.blockerCheckStates).toEqual(["Todo"]);
    expect(workflow.lifecycle.planningStates).toEqual([]);
  });

  it("defaults blocker checks to the first configured active state", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
  active_states:
    - Ready
    - Doing
  terminal_states:
    - Shipped
codex:
  command: codex app-server
---
Prompt body.
`);

    expect(workflow.tracker.blockerCheckStates).toEqual(["Ready"]);
    expect(workflow.lifecycle.planningStates).toEqual([]);
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
  provider:
    blocker_check_states: []
    planning_states:
      - Todo
codex:
  command: codex app-server
---
Prompt body.
`);

    expect(workflow.tracker.blockerCheckStates).toEqual([]);
    expect(workflow.lifecycle.planningStates).toEqual(["Todo"]);
  });

  it("parses explicit project-field priority mapping", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
  provider:
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
  provider:
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
  provider:
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

  it("ignores YAML inline comments on unquoted front matter scalars", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
  provider:
    project_id: PVT_kwHOAPiKdM4BYPVD # Moncher Stack (hojinzs/projects/14)
    state_field: Status # Project single-select field
  active_states:
    - Ready # dispatchable
    - In progress
codex:
  command: codex app-server # local runtime
---
Prompt body.
`);

    expect(workflow.githubProjectId).toBe("PVT_kwHOAPiKdM4BYPVD");
    expect(workflow.tracker.projectId).toBe("PVT_kwHOAPiKdM4BYPVD");
    expect(workflow.tracker.stateFieldName).toBe("Status");
    expect(workflow.tracker.activeStates).toEqual(["Ready", "In progress"]);
    expect(workflow.codex.command).toBe("codex app-server");
  });

  it("preserves hash characters inside quoted and plain non-comment scalars", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
  provider:
    project_id: "PVT_kwHOAPiKdM4BYPVD # quoted project marker" # trailing comment
    state_field: Status#not-a-comment
codex:
  command: 'codex # app-server'
---
Prompt body.
`);

    expect(workflow.githubProjectId).toBe(
      "PVT_kwHOAPiKdM4BYPVD # quoted project marker"
    );
    expect(workflow.tracker.stateFieldName).toBe("Status#not-a-comment");
    expect(workflow.codex.command).toBe("codex # app-server");
  });

  it("unescapes quoted priority field and mapping names", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
  provider:
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
  provider:
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
      `provider:
    priority:
      source: project-field
      values:
        P0: 0`,
      'Workflow front matter field "field" is required.',
    ],
    [
      "project-field without values",
      `provider:
    priority:
      source: project-field
      field: Priority`,
      'Workflow front matter field "tracker.priority.values" must be a non-empty object for tracker.priority.source "project-field".',
    ],
    [
      "labels without labels",
      `provider:
    priority:
      source: labels`,
      'Workflow front matter field "tracker.priority.labels" must be a non-empty object for tracker.priority.source "labels".',
    ],
    [
      "project-field with labels",
      `provider:
    priority:
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
      `provider:
    priority:
      source: labels
      field: Priority
      labels:
        P0: 0`,
      'Workflow front matter field "tracker.priority.field" is not supported for tracker.priority.source "labels".',
    ],
    [
      "disabled with values",
      `provider:
    priority:
      source: disabled
      values:
        P0: 0`,
      'Workflow front matter field "tracker.priority.values" is not supported for tracker.priority.source "disabled".',
    ],
    [
      "unknown source",
      `provider:
    priority:
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
  provider:
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

  it("parses Linear pickup label eligibility config", () => {
    const workflow = parseWorkflowMarkdown(
      `---
tracker:
  kind: linear
  provider:
    project_slug: symphony-0c79b11b75ea
    pickup_labels:
      include:
        - " Agent "
        - dev-ready
        - agent
        - " "
      exclude:
        - " NO-AGENT "
        - needs-spec
        - no-agent
codex:
  command: codex app-server
---
Prompt body.
`
    );

    expect(workflow.tracker.pickupLabels).toEqual({
      include: ["agent", "dev-ready"],
      exclude: ["no-agent", "needs-spec"],
    });
  });

  it("normalizes required labels while preserving blank labels", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
  required_labels:
    - " Ready "
    - ""
  provider:
    pickup_labels:
      include:
        - " Agent "
codex:
  command: codex app-server
---
Prompt body.
`);

    expect(workflow.tracker.requiredLabels).toEqual(["ready", ""]);
    expect(workflow.lifecycle.requiredLabels).toEqual(["ready", ""]);
    expect(workflow.tracker.pickupLabels).toEqual({
      include: ["agent"],
      exclude: [],
    });
  });

  it("rejects comma-separated required labels with the field path", () => {
    expect(() =>
      parseWorkflowMarkdown(`---
tracker:
  kind: github-project
  required_labels: ready, agent
codex:
  command: codex app-server
---
Prompt body.
`)
    ).toThrow(
      expect.objectContaining({
        code: "workflow_validation_error",
        path: "tracker.required_labels",
      })
    );
  });

  it("defaults omitted required labels to an empty list", () => {
    const workflow = parseWorkflowMarkdown(SAMPLE_WORKFLOW);

    expect(workflow.tracker.requiredLabels).toEqual([]);
    expect(workflow.lifecycle.requiredLabels).toEqual([]);
  });

  it("surfaces typed provider validation errors from the selected adapter", () => {
    const adapterError = new WorkflowValidationError(
      "workflow_validation_error",
      "tracker.provider.project_slug",
      "project_slug is required by this adapter."
    );
    expect(() =>
      parseWorkflowMarkdown(
        `---
tracker:
  kind: linear
  active_states:
    - Todo
  terminal_states:
    - Done
  provider:
    state_field: Status
codex:
  command: codex app-server
---
Prompt body.
`,
        process.env,
        { trackerAdapter: { validateProviderConfig: () => [adapterError] } }
      )
    ).toThrow(adapterError);
  });

  it("keeps command strings opaque when they contain environment syntax", () => {
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

    expect(workflow.agentCommand).toBe("${TEST_AGENT_COMMAND}");
  });

  it.each(["on-request", "untrusted"])(
    "rejects unsupported Codex approval policy %s before worker launch",
    (approvalPolicy) => {
      expect(() =>
        parseWorkflowMarkdown(`---
tracker:
  kind: github-project
codex:
  approval_policy: ${approvalPolicy}
---
Prompt body.
`)
      ).toThrow(
        'Workflow front matter field "codex.approval_policy" supports only "never" because approval requests cannot be handled.'
      );

      try {
        parseWorkflowMarkdown(`---
tracker:
  kind: github-project
codex:
  approval_policy: ${approvalPolicy}
---
Prompt body.
`);
      } catch (error) {
        expect(error).toBeInstanceOf(WorkflowValidationError);
        expect((error as WorkflowValidationError).path).toBe(
          "codex.approval_policy"
        );
      }
    }
  );

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
        trustRepoConfig: false,
        inheritEnvironment: false,
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

  it("parses explicit custom runtime environment compatibility opt-in", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
runtime:
  kind: custom
  command: node
  isolation:
    inherit_environment: true
---
Prompt body.
`);

    expect(
      (workflow.runtime?.isolation as Record<string, unknown>)
        .inheritEnvironment
    ).toBe(true);
  });

  it("rejects reserved custom runtime authentication environment names", () => {
    expect(() =>
      parseWorkflowMarkdown(
        `---
tracker:
  kind: github-project
runtime:
  kind: custom
  command: node
  auth:
    env: GITHUB_TOKEN
---
Prompt body.
`
      )
    ).toThrow(/runtime\.auth\.env.*reserved/i);
  });

  it("rejects custom runtime authentication names declared by the tracker", () => {
    expect(() =>
      parseWorkflowMarkdown(
        `---
tracker:
  kind: github-project
runtime:
  kind: custom
  command: node
  auth:
    env: TRACKER_SECRET
---
Prompt body.
`,
        {
          SYMPHONY_TRACKER_SECRET_ENVIRONMENT_NAMES: JSON.stringify([
            "TRACKER_SECRET",
          ]),
        }
      )
    ).toThrow(/runtime\.auth\.env.*reserved/i);
  });

  it("rejects the custom-only environment compatibility escape hatch for other runtimes", () => {
    expect(() =>
      parseWorkflowMarkdown(`---
tracker:
  kind: github-project
runtime:
  kind: claude-print
  isolation:
    inherit_environment: true
---
Prompt body.
`)
    ).toThrow(/inherit_environment.*custom/i);
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
    ).toThrow(/kind/);
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

  it("accepts Land as an active state for the Moncher Stack workflow", () => {
    const workflow = parseWorkflowMarkdown(`---
tracker:
  kind: github-project
  provider:
    project_id: PVT_kwHOAPiKdM4BYPVD
    state_field: Status
  active_states:
    - Ready
    - In progress
    - Land
  terminal_states:
    - Done
  provider:
    blocker_check_states:
      - Ready
codex:
  command: codex app-server
---
Prompt body.
`);

    expect(workflow.tracker.activeStates).toEqual([
      "Ready",
      "In progress",
      "Land",
    ]);
    expect(workflow.lifecycle.activeStates).toContain("Land");
    expect(isStateActive("Land", workflow.lifecycle)).toBe(true);
    expect(isStateActive("In review", workflow.lifecycle)).toBe(false);
    expect(workflow.tracker.blockerCheckStates).toEqual(["Ready"]);
  });
});

describe("WorkflowConfigStore", () => {
  it("stores a hash instead of plaintext environment values in cache metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-loader-"));
    tempDirs.push(root);
    const workflowPath = join(root, "WORKFLOW.md");
    const store = new WorkflowConfigStore({ trackerAdapter: testAdapter });
    const secret = "project-and-host-secret";
    const changedSecret = "changed-project-and-host-secret";

    await writeFile(workflowPath, SAMPLE_WORKFLOW, "utf8");
    await store.load(workflowPath, { SECRET_TOKEN: secret });

    const cache = (
      store as unknown as {
        cache: Map<string, { envSignature: string }>;
      }
    ).cache;
    const envSignature = cache.get(workflowPath)?.envSignature;

    await store.load(workflowPath, { SECRET_TOKEN: changedSecret });
    const changedEnvSignature = cache.get(workflowPath)?.envSignature;

    expect(envSignature).toMatch(/^[a-f0-9]{64}$/);
    expect(envSignature).not.toContain(secret);
    expect(changedEnvSignature).toMatch(/^[a-f0-9]{64}$/);
    expect(changedEnvSignature).not.toContain(changedSecret);
    expect(changedEnvSignature).not.toBe(envSignature);
  });

  it("keeps the last known good workflow after an invalid update", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-loader-"));
    tempDirs.push(root);
    const workflowPath = join(root, "WORKFLOW.md");
    const store = new WorkflowConfigStore({ trackerAdapter: testAdapter });

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

  it("exposes a stable, content-derived revision without workflow contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-loader-"));
    tempDirs.push(root);
    const workflowPath = join(root, "WORKFLOW.md");
    const store = new WorkflowConfigStore();

    await writeFile(workflowPath, SAMPLE_WORKFLOW, "utf8");
    const first = await store.load(workflowPath);
    const second = await store.load(workflowPath);

    expect(first.revision).toMatch(/^sha256:[a-f0-9]{12}$/);
    expect(first.revision).not.toContain("Prefer focused changes.");
    expect(second.revision).toBe(first.revision);
    expect(second.loadedAt).toBe(first.loadedAt);
    expect(
      (
        store as unknown as {
          cache: Map<string, { revision: string }>;
        }
      ).cache.get(workflowPath)?.revision
    ).toBe(first.revision);
  });

  it("changes the revision when environment resolution changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-loader-"));
    tempDirs.push(root);
    const workflowPath = join(root, "WORKFLOW.md");
    const store = new WorkflowConfigStore();

    await writeFile(
      workflowPath,
      SAMPLE_WORKFLOW.replace(".runtime/workspaces", "$WORKSPACE_ROOT"),
      "utf8"
    );

    const first = await store.load(workflowPath, {
      WORKSPACE_ROOT: "/tmp/first-workspaces",
    });
    const second = await store.load(workflowPath, {
      WORKSPACE_ROOT: "/tmp/second-workspaces",
    });

    expect(second.revision).not.toBe(first.revision);
    expect(second.workflow.workspace.root).toBe("/tmp/second-workspaces");
  });
});
