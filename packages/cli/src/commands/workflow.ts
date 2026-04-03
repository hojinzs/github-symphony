import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildPromptVariables,
  parseWorkflowMarkdown,
  renderPrompt,
  type TrackedIssue,
} from "@gh-symphony/core";
import type { GlobalOptions } from "../index.js";
import initCommand from "./init.js";

type WorkflowSubcommand = "init" | "validate" | "preview";

type ParsedWorkflowArgs = {
  subcommand?: WorkflowSubcommand;
  args: string[];
  error?: string;
};

type ValidateFlags = {
  file?: string;
};

type PreviewFlags = {
  attempt: number | null;
  file?: string;
  sample?: string;
};

type WorkflowValidationReport = {
  ok: boolean;
  workflowPath: string;
  format: string;
  checks: {
    promptFresh: "pass";
    promptRetry: "pass";
    continuationGuidance: "pass" | "skip";
  };
  summary: {
    trackerKind: string | null;
    githubProjectId: string | null;
    stateFieldName: string;
    activeStates: string[];
    terminalStates: string[];
    blockerCheckStates: string[];
    pollingIntervalMs: number;
    workspaceRoot: string | null;
    agentCommand: string;
    maxConcurrentAgents: number;
    maxFailureRetries: number;
    maxTurns: number;
    retryBaseDelayMs: number;
    maxRetryBackoffMs: number;
    codex: {
      approvalPolicy: string | null;
      threadSandbox: string | null;
      turnSandboxPolicy: string | null;
      readTimeoutMs: number;
      stallTimeoutMs: number;
      turnTimeoutMs: number;
    };
    hooks: {
      afterCreate: string | null;
      beforeRun: string | null;
      afterRun: string | null;
      beforeRemove: string | null;
      timeoutMs: number;
    };
  };
};

const SAMPLE_ISSUE: TrackedIssue = {
  id: "issue-157-sample",
  identifier: "octo/hello-world#157",
  number: 157,
  title: "Add workflow validate and preview commands",
  description:
    "Expose strict WORKFLOW.md validation and prompt preview flows in the CLI.",
  priority: 1,
  state: "In progress",
  branchName: "feat/workflow-cli-preview",
  url: "https://github.com/octo/hello-world/issues/157",
  labels: ["enhancement", "cli"],
  blockedBy: [
    {
      id: "issue-120",
      identifier: "octo/hello-world#120",
      state: "Done",
    },
  ],
  createdAt: "2026-03-31T02:06:39Z",
  updatedAt: "2026-04-03T02:28:21Z",
  repository: {
    owner: "octo",
    name: "hello-world",
    cloneUrl: "https://github.com/octo/hello-world.git",
    url: "https://github.com/octo/hello-world",
  },
  tracker: {
    adapter: "github-project",
    bindingId: "sample-binding",
    itemId: "sample-item",
  },
  metadata: {},
};

const SAMPLE_CONTINUATION_VARIABLES = {
  issue: buildPromptVariables(SAMPLE_ISSUE, { attempt: 2 }).issue,
  attempt: 2,
  lastTurnSummary: "Validated the prompt template and updated the CLI routing.",
  cumulativeTurnCount: 3,
};

function parseWorkflowArgs(args: string[]): ParsedWorkflowArgs {
  const [subcommand, ...rest] = args;

  if (!subcommand) {
    return { args: [] };
  }

  if (
    subcommand === "init" ||
    subcommand === "validate" ||
    subcommand === "preview"
  ) {
    return { subcommand, args: rest };
  }

  if (subcommand === "--help" || subcommand === "-h") {
    return { args: ["--help"] };
  }

  return {
    args: rest,
    error: `Unknown workflow subcommand '${subcommand}'`,
  };
}

function parseValidateFlags(args: string[]): ValidateFlags {
  const flags: ValidateFlags = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === "--file") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("Option '--file' argument missing");
      }
      flags.file = value;
      i += 1;
      continue;
    }

    if (arg?.startsWith("-")) {
      throw new Error(`Unknown option '${arg}'`);
    }
  }

  return flags;
}

function parsePreviewFlags(args: string[]): PreviewFlags {
  const flags: PreviewFlags = {
    attempt: null,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const value = args[i + 1];

    switch (arg) {
      case "--file":
        if (!value || value.startsWith("-")) {
          throw new Error("Option '--file' argument missing");
        }
        flags.file = value;
        i += 1;
        break;
      case "--sample":
        if (!value || value.startsWith("-")) {
          throw new Error("Option '--sample' argument missing");
        }
        flags.sample = value;
        i += 1;
        break;
      case "--attempt":
        if (!value || value.startsWith("-")) {
          throw new Error("Option '--attempt' argument missing");
        }
        flags.attempt = parseAttempt(value);
        i += 1;
        break;
      default:
        if (arg?.startsWith("-")) {
          throw new Error(`Unknown option '${arg}'`);
        }
        break;
    }
  }

  return flags;
}

function parseAttempt(value: string): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error("Option '--attempt' must be a positive integer");
  }

  return parsed;
}

function printWorkflowUsage(): void {
  process.stdout.write(`Usage: gh-symphony workflow <command> [options]

Commands:
  init       Generate WORKFLOW.md and workflow support files
  validate   Parse and strictly validate a WORKFLOW.md file
  preview    Render the final worker prompt from a sample issue

Options:
  workflow init [--non-interactive] [--project <id>] [--output <path>] [--skip-skills] [--skip-context] [--dry-run]
  workflow validate [--file <path>]
  workflow preview [--file <path>] [--sample <json>] [--attempt <n>]
`);
}

async function loadWorkflowMarkdown(
  workflowPath?: string
): Promise<{ workflowPath: string; markdown: string }> {
  const resolvedPath = resolve(workflowPath ?? "WORKFLOW.md");
  const markdown = await readFile(resolvedPath, "utf8");

  return {
    workflowPath: resolvedPath,
    markdown,
  };
}

function normalizeIssue(value: unknown): TrackedIssue {
  if (!value || typeof value !== "object") {
    throw new Error("Sample JSON must be an object.");
  }

  const record = value as Record<string, unknown>;
  const repositoryRecord = asRecord(record.repository, "repository");
  const repositoryOwner = readRequiredString(
    repositoryRecord.owner,
    "repository.owner"
  );
  const repositoryName = readRequiredString(
    repositoryRecord.name,
    "repository.name"
  );
  const repositoryUrl = readOptionalString(repositoryRecord.url);

  return {
    id: readRequiredString(record.id, "id"),
    identifier: readRequiredString(record.identifier, "identifier"),
    number: readRequiredNumber(record.number, "number"),
    title: readRequiredString(record.title, "title"),
    description: readOptionalString(record.description),
    priority: readOptionalNumber(record.priority),
    state: readRequiredString(record.state, "state"),
    branchName: readOptionalString(record.branchName ?? record.branch_name),
    url: readOptionalString(record.url),
    labels: readStringArray(record.labels, "labels"),
    blockedBy: readBlockers(record.blockedBy ?? record.blocked_by),
    createdAt: readOptionalString(record.createdAt ?? record.created_at),
    updatedAt: readOptionalString(record.updatedAt ?? record.updated_at),
    repository: {
      owner: repositoryOwner,
      name: repositoryName,
      cloneUrl:
        readOptionalString(repositoryRecord.cloneUrl) ??
        `https://github.com/${repositoryOwner}/${repositoryName}.git`,
      ...(repositoryUrl ? { url: repositoryUrl } : {}),
    },
    tracker: {
      adapter: "github-project",
      bindingId: "preview-sample",
      itemId: readOptionalString(record.itemId) ?? "preview-sample",
    },
    metadata: {},
  };
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Sample JSON field '${field}' must be an object.`);
  }

  return value as Record<string, unknown>;
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Sample JSON field '${field}' must be a non-empty string.`);
  }

  return value;
}

function readOptionalString(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error("Expected a string value.");
  }
  return value;
}

function readRequiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Sample JSON field '${field}' must be a number.`);
  }

  return value;
}

function readOptionalNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Expected a numeric value.");
  }
  return value;
}

function readStringArray(value: unknown, field: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`Sample JSON field '${field}' must be an array of strings.`);
  }

  return value as string[];
}

function readBlockers(value: unknown): TrackedIssue["blockedBy"] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Sample JSON field 'blockedBy' must be an array.");
  }

  return value.map((entry, index) => {
    const record = asRecord(entry, `blockedBy[${index}]`);
    return {
      id: readOptionalString(record.id),
      identifier: readOptionalString(record.identifier),
      state: readOptionalString(record.state),
    };
  });
}

async function loadSampleIssue(samplePath?: string): Promise<{
  issue: TrackedIssue;
  sampleSource: string;
}> {
  if (!samplePath) {
    return { issue: SAMPLE_ISSUE, sampleSource: "built-in" };
  }

  const resolvedPath = resolve(samplePath);
  const raw = await readFile(resolvedPath, "utf8");

  return {
    issue: normalizeIssue(JSON.parse(raw) as unknown),
    sampleSource: resolvedPath,
  };
}

function validateWorkflow(
  workflowPath: string,
  markdown: string
): WorkflowValidationReport {
  const workflow = parseWorkflowMarkdown(markdown);
  const promptFreshVariables = buildPromptVariables(SAMPLE_ISSUE, {
    attempt: null,
  });
  const promptRetryVariables = buildPromptVariables(SAMPLE_ISSUE, {
    attempt: 2,
  });

  renderPrompt(workflow.promptTemplate, promptFreshVariables, { strict: true });
  renderPrompt(workflow.promptTemplate, promptRetryVariables, { strict: true });

  const continuationGuidanceStatus = workflow.continuationGuidance
    ? (() => {
        renderPrompt(
          workflow.continuationGuidance,
          SAMPLE_CONTINUATION_VARIABLES as typeof promptRetryVariables,
          { strict: true }
        );
        return "pass" as const;
      })()
    : ("skip" as const);

  return {
    ok: true,
    workflowPath,
    format: workflow.format,
    checks: {
      promptFresh: "pass",
      promptRetry: "pass",
      continuationGuidance: continuationGuidanceStatus,
    },
    summary: {
      trackerKind: workflow.tracker.kind,
      githubProjectId: workflow.githubProjectId,
      stateFieldName: workflow.lifecycle.stateFieldName,
      activeStates: workflow.lifecycle.activeStates,
      terminalStates: workflow.lifecycle.terminalStates,
      blockerCheckStates: workflow.lifecycle.blockerCheckStates,
      pollingIntervalMs: workflow.polling.intervalMs,
      workspaceRoot: workflow.workspace.root,
      agentCommand: workflow.agentCommand,
      maxConcurrentAgents: workflow.agent.maxConcurrentAgents,
      maxFailureRetries: workflow.agent.maxFailureRetries,
      maxTurns: workflow.agent.maxTurns,
      retryBaseDelayMs: workflow.agent.retryBaseDelayMs,
      maxRetryBackoffMs: workflow.agent.maxRetryBackoffMs,
      codex: {
        approvalPolicy: workflow.codex.approvalPolicy,
        threadSandbox: workflow.codex.threadSandbox,
        turnSandboxPolicy: workflow.codex.turnSandboxPolicy,
        readTimeoutMs: workflow.codex.readTimeoutMs,
        stallTimeoutMs: workflow.codex.stallTimeoutMs,
        turnTimeoutMs: workflow.codex.turnTimeoutMs,
      },
      hooks: {
        afterCreate: workflow.hooks.afterCreate,
        beforeRun: workflow.hooks.beforeRun,
        afterRun: workflow.hooks.afterRun,
        beforeRemove: workflow.hooks.beforeRemove,
        timeoutMs: workflow.hooks.timeoutMs,
      },
    },
  };
}

function printValidationReport(report: WorkflowValidationReport): void {
  process.stdout.write(`WORKFLOW.md validation passed
Path: ${report.workflowPath}
Format: ${report.format}
Prompt checks: fresh=pass, retry=pass, continuation_guidance=${report.checks.continuationGuidance}

Lifecycle
  tracker.kind=${report.summary.trackerKind ?? "unset"}
  tracker.project_id=${report.summary.githubProjectId ?? "unset"}
  tracker.state_field=${report.summary.stateFieldName}
  active_states=${report.summary.activeStates.join(", ") || "(none)"}
  terminal_states=${report.summary.terminalStates.join(", ") || "(none)"}
  blocker_check_states=${report.summary.blockerCheckStates.join(", ") || "(none)"}

Runtime
  polling.interval_ms=${report.summary.pollingIntervalMs}
  workspace.root=${report.summary.workspaceRoot ?? "unset"}
  codex.command=${report.summary.agentCommand}
  agent.max_concurrent_agents=${report.summary.maxConcurrentAgents}
  agent.max_failure_retries=${report.summary.maxFailureRetries}
  agent.max_turns=${report.summary.maxTurns}
  agent.retry_base_delay_ms=${report.summary.retryBaseDelayMs}
  agent.max_retry_backoff_ms=${report.summary.maxRetryBackoffMs}
  codex.approval_policy=${report.summary.codex.approvalPolicy ?? "unset"}
  codex.thread_sandbox=${report.summary.codex.threadSandbox ?? "unset"}
  codex.turn_sandbox_policy=${report.summary.codex.turnSandboxPolicy ?? "unset"}
  codex.read_timeout_ms=${report.summary.codex.readTimeoutMs}
  codex.stall_timeout_ms=${report.summary.codex.stallTimeoutMs}
  codex.turn_timeout_ms=${report.summary.codex.turnTimeoutMs}

Hooks
  after_create=${report.summary.hooks.afterCreate ?? "unset"}
  before_run=${report.summary.hooks.beforeRun ?? "unset"}
  after_run=${report.summary.hooks.afterRun ?? "unset"}
  before_remove=${report.summary.hooks.beforeRemove ?? "unset"}
  hooks.timeout_ms=${report.summary.hooks.timeoutMs}
`);
}

async function runValidate(args: string[], options: GlobalOptions): Promise<void> {
  const flags = parseValidateFlags(args);
  const { workflowPath, markdown } = await loadWorkflowMarkdown(flags.file);
  const report = validateWorkflow(workflowPath, markdown);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  printValidationReport(report);
}

async function runPreview(args: string[], options: GlobalOptions): Promise<void> {
  const flags = parsePreviewFlags(args);
  const { workflowPath, markdown } = await loadWorkflowMarkdown(flags.file);
  const workflow = parseWorkflowMarkdown(markdown);
  const { issue, sampleSource } = await loadSampleIssue(flags.sample);
  const variables = buildPromptVariables(issue, {
    attempt: flags.attempt,
  });
  const renderedPrompt = renderPrompt(workflow.promptTemplate, variables, {
    strict: true,
  });

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          workflowPath,
          sampleSource,
          attempt: flags.attempt,
          renderedPrompt,
        },
        null,
        2
      )}\n`
    );
    return;
  }

  process.stdout.write(`WORKFLOW.md prompt preview
Path: ${workflowPath}
Sample: ${sampleSource}
Attempt: ${flags.attempt ?? "fresh"}

${renderedPrompt}
`);
}

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => {
  const parsed = parseWorkflowArgs(args);

  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n`);
    printWorkflowUsage();
    process.exitCode = 1;
    return;
  }

  if (parsed.args[0] === "--help" || parsed.args[0] === "-h") {
    printWorkflowUsage();
    return;
  }

  if (!parsed.subcommand) {
    process.stderr.write("Missing workflow subcommand.\n");
    printWorkflowUsage();
    process.exitCode = 1;
    return;
  }

  try {
    switch (parsed.subcommand) {
      case "init":
        await initCommand(parsed.args, options);
        return;
      case "validate":
        await runValidate(parsed.args, options);
        return;
      case "preview":
        await runPreview(parsed.args, options);
        return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Workflow command failed: ${message}\n`);
    process.exitCode = 1;
  }
};

export default handler;
