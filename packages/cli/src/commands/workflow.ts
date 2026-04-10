import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildPromptVariables,
  parseWorkflowMarkdown,
  renderPrompt,
  type TrackedIssue,
} from "@gh-symphony/core";
import { fetchGithubProjectIssueByRepositoryAndNumber } from "@gh-symphony/tracker-github";
import type { CliProjectConfig } from "../config.js";
import {
  createClient,
  findLinkedRepository,
  getProjectDetail,
  GitHubApiError,
} from "../github/client.js";
import {
  getGhTokenWithSource,
  type GhAuthError,
  validateGitHubToken,
} from "../github/gh-auth.js";
import type { GlobalOptions } from "../index.js";
import { inspectManagedProjectSelection } from "../project-selection.js";
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
  issue?: string;
  projectId?: string;
  sample?: string;
};

type PreviewIssueReference = {
  owner: string;
  name: string;
  number: number;
  identifier: string;
};

type WorkflowCommandDependencies = {
  createGitHubClient: typeof createClient;
  fetchLiveIssue: typeof fetchGithubProjectIssueByRepositoryAndNumber;
  getGitHubProjectDetail: typeof getProjectDetail;
  getGitHubTokenWithSource: typeof getGhTokenWithSource;
  resolveManagedProjectSelection: typeof inspectManagedProjectSelection;
  validateGitHubToken: typeof validateGitHubToken;
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
  lastTurnSummary: "Validated the prompt template and updated the CLI routing.",
  cumulativeTurnCount: 3,
};

const workflowCommandDependencies: WorkflowCommandDependencies = {
  createGitHubClient: createClient,
  fetchLiveIssue: fetchGithubProjectIssueByRepositoryAndNumber,
  getGitHubProjectDetail: getProjectDetail,
  getGitHubTokenWithSource: getGhTokenWithSource,
  resolveManagedProjectSelection: inspectManagedProjectSelection,
  validateGitHubToken,
};

export function setWorkflowCommandDependenciesForTest(
  overrides: Partial<WorkflowCommandDependencies>
): void {
  Object.assign(workflowCommandDependencies, overrides);
}

export function resetWorkflowCommandDependenciesForTest(): void {
  workflowCommandDependencies.createGitHubClient = createClient;
  workflowCommandDependencies.fetchLiveIssue =
    fetchGithubProjectIssueByRepositoryAndNumber;
  workflowCommandDependencies.getGitHubProjectDetail = getProjectDetail;
  workflowCommandDependencies.getGitHubTokenWithSource = getGhTokenWithSource;
  workflowCommandDependencies.resolveManagedProjectSelection =
    inspectManagedProjectSelection;
  workflowCommandDependencies.validateGitHubToken = validateGitHubToken;
}

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
      case "--issue":
        if (!value || value.startsWith("-")) {
          throw new Error("Option '--issue' argument missing");
        }
        flags.issue = value;
        i += 1;
        break;
      case "--project-id":
      case "--project":
        if (!value || value.startsWith("-")) {
          throw new Error(`Option '${arg}' argument missing`);
        }
        flags.projectId = value;
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
  preview    Render the final worker prompt from a sample or live issue

Options:
  workflow init [--non-interactive] [--project <id>] [--output <path>] [--skip-skills] [--skip-context] [--dry-run]
  workflow validate [--file <path>]
  workflow preview [--file <path>] [--issue <owner/repo#number>] [--project-id <projectId>] [--sample <json>] [--attempt <n>]
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
  const repositoryUrl = readOptionalString(
    repositoryRecord.url,
    "repository.url"
  );

  return {
    id: readRequiredString(record.id, "id"),
    identifier: readRequiredString(record.identifier, "identifier"),
    number: readRequiredNumber(record.number, "number"),
    title: readRequiredString(record.title, "title"),
    description: readOptionalString(record.description, "description"),
    priority: readOptionalNumber(record.priority, "priority"),
    state: readRequiredString(record.state, "state"),
    branchName: readOptionalString(
      record.branchName ?? record.branch_name,
      "branchName/branch_name"
    ),
    url: readOptionalString(record.url, "url"),
    labels: readStringArray(record.labels, "labels"),
    blockedBy: readBlockers(record.blockedBy ?? record.blocked_by),
    createdAt: readOptionalString(
      record.createdAt ?? record.created_at,
      "createdAt/created_at"
    ),
    updatedAt: readOptionalString(
      record.updatedAt ?? record.updated_at,
      "updatedAt/updated_at"
    ),
    repository: {
      owner: repositoryOwner,
      name: repositoryName,
      cloneUrl:
        readOptionalString(repositoryRecord.cloneUrl, "repository.cloneUrl") ??
        `https://github.com/${repositoryOwner}/${repositoryName}.git`,
      ...(repositoryUrl ? { url: repositoryUrl } : {}),
    },
    tracker: {
      adapter: "github-project",
      bindingId: "preview-sample",
      itemId: readOptionalString(record.itemId, "itemId") ?? "preview-sample",
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

function readOptionalString(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`Sample JSON field '${field}' must be a string.`);
  }
  return value;
}

function readRequiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Sample JSON field '${field}' must be a number.`);
  }

  return value;
}

function readOptionalNumber(value: unknown, field: string): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Sample JSON field '${field}' must be a number.`);
  }
  return value;
}

function readStringArray(value: unknown, field: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new Error(
      `Sample JSON field '${field}' must be an array of strings.`
    );
  }

  return value as string[];
}

function readBlockers(value: unknown): TrackedIssue["blockedBy"] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(
      "Sample JSON field 'blockedBy/blocked_by' must be an array."
    );
  }

  return value.map((entry, index) => {
    const record = asRecord(entry, `blockedBy/blocked_by[${index}]`);
    return {
      id: readOptionalString(record.id, `blockedBy/blocked_by[${index}].id`),
      identifier: readOptionalString(
        record.identifier,
        `blockedBy/blocked_by[${index}].identifier`
      ),
      state: readOptionalString(
        record.state,
        `blockedBy/blocked_by[${index}].state`
      ),
    };
  });
}

function validateContinuationGuidance(template: string): void {
  if (template.includes("{%") || template.includes("%}")) {
    throw new Error(
      "template_parse_error: continuation guidance does not support Liquid tags."
    );
  }

  const pattern = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g;
  let rendered = "";
  let lastIndex = 0;

  for (const match of template.matchAll(pattern)) {
    const expression = match[1];
    const index = match.index ?? 0;
    rendered += template.slice(lastIndex, index);

    if (!(expression in SAMPLE_CONTINUATION_VARIABLES)) {
      throw new Error(
        `template_render_error: unsupported continuation guidance variable '${expression}'.`
      );
    }

    rendered += String(
      SAMPLE_CONTINUATION_VARIABLES[
        expression as keyof typeof SAMPLE_CONTINUATION_VARIABLES
      ]
    );
    lastIndex = index + match[0].length;
  }

  rendered += template.slice(lastIndex);

  const strayLiquidExpression = rendered.match(/\{\{[^}]*\}\}/);
  if (strayLiquidExpression) {
    throw new Error(
      `template_parse_error: invalid continuation guidance expression '${strayLiquidExpression[0]}'.`
    );
  }
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

function parseIssueReference(value: string): PreviewIssueReference {
  const match =
    /^(?<owner>[A-Za-z0-9_.-]+)\/(?<name>[A-Za-z0-9_.-]+)#(?<number>\d+)$/.exec(
      value.trim()
    );

  if (!match?.groups) {
    throw new Error(
      "Option '--issue' must be in the format 'owner/repo#number'."
    );
  }

  return {
    owner: match.groups.owner,
    name: match.groups.name,
    number: Number.parseInt(match.groups.number, 10),
    identifier: `${match.groups.owner}/${match.groups.name}#${match.groups.number}`,
  };
}

function readGitHubProjectBinding(
  projectConfig: CliProjectConfig
): string | null {
  const bindingId = projectConfig.tracker.bindingId?.trim();
  if (bindingId) {
    return bindingId;
  }

  const settingsProjectId = projectConfig.tracker.settings?.projectId;
  return typeof settingsProjectId === "string" &&
    settingsProjectId.trim().length > 0
    ? settingsProjectId.trim()
    : null;
}

function formatAuthError(error: GhAuthError | Error): string {
  return `GitHub authentication is required for live issue preview. ${error.message}`;
}

async function loadLiveIssue(
  issueReference: string,
  projectId: string | undefined,
  options: GlobalOptions
): Promise<{
  issue: TrackedIssue;
  sampleSource: string;
}> {
  const issue = parseIssueReference(issueReference);
  const selection =
    await workflowCommandDependencies.resolveManagedProjectSelection({
      configDir: options.configDir,
      requestedProjectId: projectId,
    });

  if (selection.kind !== "resolved") {
    throw new Error(selection.message);
  }

  const githubProjectId = readGitHubProjectBinding(selection.projectConfig);
  if (!githubProjectId) {
    throw new Error(
      `Managed project "${selection.projectId}" is not bound to a GitHub Project. Re-run 'gh-symphony project add' and select a valid GitHub Project binding.`
    );
  }

  let auth: Awaited<ReturnType<typeof validateGitHubToken>>;
  try {
    const tokenResult = workflowCommandDependencies.getGitHubTokenWithSource();
    auth = await workflowCommandDependencies.validateGitHubToken(
      tokenResult.token,
      tokenResult.source
    );
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(formatAuthError(error));
    }
    throw error;
  }

  const client = workflowCommandDependencies.createGitHubClient(auth.token, {
    apiUrl: selection.projectConfig.tracker.apiUrl,
  });

  let detail: Awaited<ReturnType<typeof getProjectDetail>>;
  try {
    detail = await workflowCommandDependencies.getGitHubProjectDetail(
      client,
      githubProjectId
    );
  } catch (error) {
    const message =
      error instanceof GitHubApiError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Unknown GitHub API error.";
    throw new Error(
      `Failed to resolve the configured GitHub Project binding '${githubProjectId}': ${message}`
    );
  }

  if (!findLinkedRepository(detail, issue.owner, issue.name)) {
    throw new Error(
      `Repository ${issue.owner}/${issue.name} is not linked to the configured GitHub Project "${detail.title}". Run 'gh-symphony repo add ${issue.owner}/${issue.name}' or re-run 'gh-symphony project add' with the correct project binding.`
    );
  }

  const trackedIssue = await workflowCommandDependencies.fetchLiveIssue(
    {
      projectId: githubProjectId,
      token: auth.token,
      apiUrl: selection.projectConfig.tracker.apiUrl,
      assignedOnly:
        selection.projectConfig.tracker.settings?.assignedOnly === true,
      priorityFieldName:
        typeof selection.projectConfig.tracker.settings?.priorityFieldName ===
        "string"
          ? selection.projectConfig.tracker.settings.priorityFieldName
          : undefined,
      timeoutMs:
        typeof selection.projectConfig.tracker.settings?.timeoutMs === "number"
          ? selection.projectConfig.tracker.settings.timeoutMs
          : undefined,
    },
    {
      owner: issue.owner,
      name: issue.name,
    },
    issue.number
  );

  if (!trackedIssue) {
    throw new Error(
      `Issue ${issue.identifier} is not in the configured GitHub Project "${detail.title}". Add the issue to the project and re-run the preview.`
    );
  }

  return {
    issue: trackedIssue,
    sampleSource: `live:${trackedIssue.identifier}`,
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
        validateContinuationGuidance(workflow.continuationGuidance);
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

async function runValidate(
  args: string[],
  options: GlobalOptions
): Promise<void> {
  const flags = parseValidateFlags(args);
  const { workflowPath, markdown } = await loadWorkflowMarkdown(flags.file);
  const report = validateWorkflow(workflowPath, markdown);

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  printValidationReport(report);
}

async function runPreview(
  args: string[],
  options: GlobalOptions
): Promise<void> {
  const flags = parsePreviewFlags(args);
  if (flags.sample && flags.issue) {
    throw new Error(
      "Options '--sample' and '--issue' cannot be used together."
    );
  }
  const { workflowPath, markdown } = await loadWorkflowMarkdown(flags.file);
  const workflow = parseWorkflowMarkdown(markdown);
  if (flags.issue && workflow.tracker.kind !== "github-project") {
    throw new Error(
      "Live issue preview requires 'tracker.kind: github-project' in WORKFLOW.md."
    );
  }
  const { issue, sampleSource } = flags.issue
    ? await loadLiveIssue(flags.issue, flags.projectId, options)
    : await loadSampleIssue(flags.sample);
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
