import { constants } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import {
  parseWorkflowMarkdown,
  type ParsedWorkflow,
  type TrackedIssue,
} from "@gh-symphony/core";
import {
  runClaudePreflight,
  isClaudeRuntimeCommand,
  resolveClaudeCommandBinary,
  resolveRuntimeCommandBinary,
  type ClaudePreflightCheck,
} from "@gh-symphony/runtime-claude";
import {
  fetchGithubProjectIssueByRepositoryAndNumber,
  fetchGithubProjectIssues,
} from "@gh-symphony/tracker-github";
import {
  createClient,
  findLinkedRepository,
  getProjectDetail,
  GitHubApiError,
  listRepositoryLabels,
  type ProjectDetail,
} from "../github/client.js";
import {
  checkGhAuthenticated,
  checkGhInstalled,
  checkGhScopes,
  getEnvGitHubToken,
  getGhToken,
  type GitHubAuthSource,
  type ResolvedGitHubAuth,
  REQUIRED_GH_SCOPES,
  validateGitHubToken,
  runGhAuthLogin,
  runGhAuthRefresh,
} from "../github/gh-auth.js";
import type { GlobalOptions } from "../index.js";
import { resolveRuntimeRoot } from "../orchestrator-runtime.js";
import {
  buildPriorityConfigDiagnostics,
  buildPriorityDriftDiagnostics,
} from "../priority-diagnostics.js";
import { inspectManagedProjectSelection } from "../project-selection.js";
import {
  createSupportBundle,
  type SupportBundleSummary,
} from "../support/bundle.js";
import {
  parseIssueReference,
  readGitHubProjectBinding,
  renderIssueWorkflowPreview,
} from "./workflow.js";

type DoctorStatus = "pass" | "warn" | "fail";
type DoctorRemediationStatus = "applied" | "skipped" | "manual";

type DoctorCheckId =
  | "node_runtime"
  | "git_installation"
  | "gh_installation"
  | "gh_authentication"
  | "gh_scopes"
  | "managed_project"
  | "github_project_resolution"
  | "config_directory"
  | "runtime_root"
  | "workspace_root"
  | "workflow_file"
  | "runtime_command"
  | "project_repository_link"
  | "smoke_issue"
  | "workflow_prompt_render"
  | "workflow_hooks"
  | "priority_mapping"
  | "claude_binary"
  | "anthropic_api_key"
  | "claude_mcp_config";

type PathCheckReason = "missing" | "not_directory" | "not_writable";
type WorkflowCheckReason = "missing" | "invalid";
type ProjectResolutionReason =
  | "token_unavailable"
  | "missing_binding"
  | "api_error"
  | "selection_failed";

type ResolvedManagedProjectSelection = Extract<
  Awaited<ReturnType<typeof inspectManagedProjectSelection>>,
  { kind: "resolved" }
>;

export type DoctorCheckResult = {
  id: DoctorCheckId;
  title: string;
  status: DoctorStatus;
  required: true;
  summary: string;
  remediation?: string;
  details?: Record<string, unknown>;
};

export type DoctorRemediationStep = {
  id: string;
  checkId: DoctorCheckId;
  title: string;
  status: DoctorRemediationStatus;
  summary: string;
  command?: string;
  details?: Record<string, unknown>;
};

export type DoctorReport = {
  ok: boolean;
  checkedAt: string;
  configDir: string;
  projectId: string | null;
  authSource: GitHubAuthSource | null;
  authLogin: string | null;
  checks: DoctorCheckResult[];
  remediation?: {
    attempted: boolean;
    steps: DoctorRemediationStep[];
  };
};

type ParsedDoctorArgs = {
  projectId?: string;
  fix: boolean;
  smoke: boolean;
  bundle: boolean;
  bundlePath?: string;
  issue?: string;
  error?: string;
};

type WorkflowCheckState =
  | {
      status: "pass";
      command: string;
      workflowPath: string;
      format: string;
      workflow: ParsedWorkflow;
    }
  | {
      status: "fail";
      reason: WorkflowCheckReason;
      summary: string;
      remediation: string;
      workflowPath: string;
      error?: string;
    };

type PathState = {
  exists: boolean;
  isDirectory: boolean;
  writable: boolean;
  code?: string;
};

export type DoctorDependencies = {
  checkGhInstalled: typeof checkGhInstalled;
  checkGhAuthenticated: typeof checkGhAuthenticated;
  checkGhScopes: typeof checkGhScopes;
  getEnvGitHubToken: typeof getEnvGitHubToken;
  getGhToken: typeof getGhToken;
  validateGitHubToken: typeof validateGitHubToken;
  inspectManagedProjectSelection: typeof inspectManagedProjectSelection;
  createClient: typeof createClient;
  getProjectDetail: typeof getProjectDetail;
  listRepositoryLabels: typeof listRepositoryLabels;
  fetchProjectIssues: typeof fetchGithubProjectIssues;
  fetchProjectIssue: typeof fetchGithubProjectIssueByRepositoryAndNumber;
  readFile: typeof readFile;
  access: typeof access;
  mkdir: typeof mkdir;
  stat: typeof stat;
  parseWorkflowMarkdown: typeof parseWorkflowMarkdown;
  execFileSync: typeof execFileSync;
  runGhAuthLogin: typeof runGhAuthLogin;
  runGhAuthRefresh: typeof runGhAuthRefresh;
  spawnSync: typeof spawnSync;
  pathEnv: string | undefined;
  pathExtEnv: string | undefined;
  platform: NodeJS.Platform;
  processVersion: string;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  execPath: string;
  cliArgv: string[];
  fetchImpl: typeof fetch;
};

const DEFAULT_DEPENDENCIES: DoctorDependencies = {
  checkGhInstalled,
  checkGhAuthenticated,
  checkGhScopes,
  getEnvGitHubToken,
  getGhToken,
  validateGitHubToken,
  inspectManagedProjectSelection,
  createClient,
  getProjectDetail,
  listRepositoryLabels,
  fetchProjectIssues: fetchGithubProjectIssues,
  fetchProjectIssue: fetchGithubProjectIssueByRepositoryAndNumber,
  readFile,
  access,
  mkdir,
  stat,
  parseWorkflowMarkdown,
  execFileSync,
  runGhAuthLogin,
  runGhAuthRefresh,
  spawnSync,
  pathEnv: process.env.PATH,
  pathExtEnv: process.env.PATHEXT,
  platform: process.platform,
  processVersion: process.version,
  stdinIsTTY: process.stdin.isTTY === true,
  stdoutIsTTY: process.stdout.isTTY === true,
  execPath: process.execPath,
  cliArgv: [...process.argv],
  fetchImpl: fetch,
};

const MINIMUM_NODE_MAJOR = 24;
const MINIMUM_NODE_VERSION = `v${MINIMUM_NODE_MAJOR}.0.0`;
const DOCTOR_USAGE =
  "Usage: gh-symphony doctor [--project-id <project-id>] [--fix] [--smoke] [--issue <owner/repo#number>] [--bundle [path]]";

type GitInstallationState =
  | {
      installed: true;
      version: string;
    }
  | {
      installed: false;
      error?: string;
    };

function parseDoctorArgs(args: string[]): ParsedDoctorArgs {
  const parsed: ParsedDoctorArgs = { fix: false, smoke: false, bundle: false };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--project" || arg === "--project-id") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        parsed.error = `Option '${arg}' argument missing`;
        return parsed;
      }
      parsed.projectId = value;
      i += 1;
      continue;
    }

    if (arg === "--fix") {
      parsed.fix = true;
      continue;
    }

    if (arg === "--smoke") {
      parsed.smoke = true;
      continue;
    }

    if (arg === "--bundle") {
      parsed.bundle = true;
      const value = args[i + 1];
      if (value && !value.startsWith("-")) {
        parsed.bundlePath = value;
        i += 1;
      }
      continue;
    }

    if (arg === "--issue") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        parsed.error = "Option '--issue' argument missing";
        return parsed;
      }
      parsed.issue = value;
      i += 1;
      continue;
    }

    if (arg?.startsWith("-")) {
      parsed.error = `Unknown option '${arg}'`;
      return parsed;
    }

    parsed.error = `Unexpected argument '${arg}'`;
    return parsed;
  }

  if (parsed.issue && !parsed.smoke) {
    parsed.error = "Option '--issue' requires '--smoke'";
  }
  if (parsed.bundle && parsed.fix) {
    parsed.error = "Option '--fix' cannot be used with '--bundle'";
  }

  return parsed;
}

function passCheck(
  id: DoctorCheckId,
  title: string,
  summary: string,
  details?: Record<string, unknown>
): DoctorCheckResult {
  return { id, title, status: "pass", required: true, summary, details };
}

function failCheck(
  id: DoctorCheckId,
  title: string,
  summary: string,
  remediation: string,
  details?: Record<string, unknown>
): DoctorCheckResult {
  return {
    id,
    title,
    status: "fail",
    required: true,
    summary,
    remediation,
    details,
  };
}

function warnCheck(
  id: DoctorCheckId,
  title: string,
  summary: string,
  remediation?: string,
  details?: Record<string, unknown>
): DoctorCheckResult {
  return {
    id,
    title,
    status: "warn",
    required: true,
    summary,
    remediation,
    details,
  };
}

function formatAuthSource(source: GitHubAuthSource): string {
  return source === "env" ? "GITHUB_GRAPHQL_TOKEN" : "gh CLI";
}

function remediationStep(
  id: string,
  checkId: DoctorCheckId,
  title: string,
  status: DoctorRemediationStatus,
  summary: string,
  command?: string,
  details?: Record<string, unknown>
): DoctorRemediationStep {
  return { id, checkId, title, status, summary, command, details };
}

async function inspectPathState(
  targetPath: string,
  deps: Pick<DoctorDependencies, "access" | "stat">
): Promise<PathState> {
  try {
    const target = await deps.stat(targetPath);
    if (!target.isDirectory()) {
      return {
        exists: true,
        isDirectory: false,
        writable: false,
      };
    }

    try {
      await deps.access(targetPath, constants.W_OK);
      return {
        exists: true,
        isDirectory: true,
        writable: true,
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      return {
        exists: true,
        isDirectory: true,
        writable: false,
        code: err.code,
      };
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT" || err.code === "ENOTDIR") {
      return {
        exists: false,
        isDirectory: false,
        writable: false,
        code: err.code,
      };
    }
    throw error;
  }
}

function buildPathCheck(
  id: "config_directory" | "runtime_root" | "workspace_root",
  title: string,
  targetPath: string,
  state: PathState,
  createCommand: string,
  fallbackRemediation: string
): DoctorCheckResult {
  if (state.exists && state.isDirectory && state.writable) {
    return passCheck(id, title, `${title} is writable: ${targetPath}.`, {
      path: targetPath,
    });
  }

  let summary = `${title} is not writable: ${targetPath}.`;
  let reason: PathCheckReason = "not_writable";
  let remediation = fallbackRemediation;

  if (!state.exists) {
    summary = `${title} does not exist: ${targetPath}.`;
    reason = "missing";
    remediation = `Create the directory before re-running doctor with: ${createCommand}.`;
  } else if (!state.isDirectory) {
    summary = `${title} is not a directory: ${targetPath}.`;
    reason = "not_directory";
    remediation = `Move or remove the conflicting file at '${targetPath}', then create the directory with: ${createCommand}.`;
  }

  return failCheck(id, title, summary, remediation, {
    path: targetPath,
    reason,
  });
}

function quotePosixShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function quotePowerShellArg(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteCommandArg(value: string, platform: NodeJS.Platform): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) {
    return value;
  }
  return platform === "win32"
    ? quotePowerShellArg(value)
    : quotePosixShellArg(value);
}

function formatEnsureDirectoryCommand(
  pathValue: string,
  platform: NodeJS.Platform
): string {
  if (platform === "win32") {
    return `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path ${quotePowerShellArg(pathValue)} | Out-Null"`;
  }

  return `mkdir -p -- ${quotePosixShellArg(pathValue)}`;
}

function formatGhSymphonyCommand(
  args: string[],
  deps: Pick<DoctorDependencies, "platform">,
  options: Pick<GlobalOptions, "configDir">
): string {
  const commandArgs = ["--config", options.configDir, ...args].map((arg) =>
    quoteCommandArg(arg, deps.platform)
  );
  return `gh-symphony ${commandArgs.join(" ")}`;
}

function getCommandCandidates(
  binary: string,
  deps: Pick<DoctorDependencies, "platform" | "pathExtEnv">
): string[] {
  if (deps.platform !== "win32") {
    return [binary];
  }

  const pathExts = (deps.pathExtEnv ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim())
    .filter(Boolean);
  const normalizedBinary = binary.toLowerCase();
  if (pathExts.some((ext) => normalizedBinary.endsWith(ext.toLowerCase()))) {
    return [binary];
  }

  return [binary, ...pathExts.map((ext) => `${binary}${ext}`)];
}

async function commandExistsOnPath(
  binary: string,
  deps: Pick<
    DoctorDependencies,
    "access" | "pathEnv" | "pathExtEnv" | "platform"
  >
): Promise<boolean> {
  if (!binary) {
    return false;
  }

  const candidates = getCommandCandidates(binary, deps);
  if (isAbsolute(binary) || binary.includes("/") || binary.includes("\\")) {
    for (const candidate of candidates) {
      try {
        await deps.access(resolve(candidate), constants.X_OK);
        return true;
      } catch {
        continue;
      }
    }

    return false;
  }

  for (const segment of (deps.pathEnv ?? "").split(delimiter)) {
    if (!segment) {
      continue;
    }
    for (const command of candidates) {
      const candidate = join(segment, command);
      try {
        await deps.access(candidate, constants.X_OK);
        return true;
      } catch {
        continue;
      }
    }
  }

  return false;
}

function toDoctorClaudeCheck(check: ClaudePreflightCheck): DoctorCheckResult {
  const id: DoctorCheckId = check.id;
  if (check.status === "pass") {
    return passCheck(id, check.title, check.summary, check.details);
  }
  if (check.status === "warn") {
    return warnCheck(
      id,
      check.title,
      check.summary,
      check.remediation,
      check.details
    );
  }
  return failCheck(
    id,
    check.title,
    check.summary,
    check.remediation ?? "Fix the Claude runtime readiness check.",
    check.details
  );
}

function parseMajorNodeVersion(version: string): number | null {
  const matched = version.match(/^v?(\d+)(?:\.\d+)?(?:\.\d+)?$/);
  if (!matched) {
    return null;
  }

  return Number.parseInt(matched[1]!, 10);
}

async function checkGitInstallation(
  deps: Pick<
    DoctorDependencies,
    "access" | "pathEnv" | "pathExtEnv" | "platform" | "execFileSync"
  >
): Promise<GitInstallationState> {
  const installed = await commandExistsOnPath("git", deps);
  if (!installed) {
    return { installed: false };
  }

  try {
    const version = deps
      .execFileSync("git", ["--version"], {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      })
      .toString()
      .trim();

    return version
      ? { installed: true, version }
      : {
          installed: false,
          error: "git --version returned an empty response.",
        };
  } catch (error) {
    return {
      installed: false,
      error:
        error instanceof Error ? error.message : "Unknown Git execution error.",
    };
  }
}

async function checkWorkflow(
  repoRoot: string,
  deps: Pick<DoctorDependencies, "readFile" | "parseWorkflowMarkdown">
): Promise<WorkflowCheckState> {
  const workflowPath = join(repoRoot, "WORKFLOW.md");
  let markdown: string;

  try {
    markdown = await deps.readFile(workflowPath, "utf8");
  } catch {
    return {
      status: "fail",
      reason: "missing",
      workflowPath,
      summary: "WORKFLOW.md was not found in the repository root.",
      remediation:
        "Run 'gh-symphony workflow init' in this repository or add a valid WORKFLOW.md at the repo root.",
    };
  }

  try {
    const parsed = deps.parseWorkflowMarkdown(markdown, process.env);
    return {
      status: "pass",
      command: parsed.agentCommand,
      workflowPath,
      format: parsed.format,
      workflow: parsed,
    };
  } catch (error) {
    return {
      status: "fail",
      reason: "invalid",
      workflowPath,
      summary: "WORKFLOW.md could not be parsed.",
      remediation:
        "Fix the WORKFLOW.md front matter or re-run 'gh-symphony workflow init' to regenerate it.",
      error:
        error instanceof Error
          ? error.message
          : "Unknown workflow parse error.",
    };
  }
}

function buildGithubTrackerConfig(input: {
  projectConfig: ResolvedManagedProjectSelection;
  bindingId: string;
  token: string;
  workflow: ParsedWorkflow;
}) {
  const settings = input.projectConfig.projectConfig.tracker.settings;
  return {
    projectId: input.bindingId,
    token: input.token,
    apiUrl: input.projectConfig.projectConfig.tracker.apiUrl,
    lifecycle: input.workflow.lifecycle,
    assignedOnly: settings?.assignedOnly === true,
    priority: input.workflow.tracker.priority,
    priorityFieldName:
      typeof settings?.priorityFieldName === "string"
        ? settings.priorityFieldName
        : undefined,
    timeoutMs:
      typeof settings?.timeoutMs === "number" ? settings.timeoutMs : undefined,
  };
}

async function buildPriorityMappingChecks(input: {
  auth: ResolvedGitHubAuth | null;
  selection: Awaited<ReturnType<typeof inspectManagedProjectSelection>> | null;
  workflow: WorkflowCheckState;
  projectDetail: ProjectDetail | null;
  projectBindingId: string | null;
  deps: DoctorDependencies;
}): Promise<DoctorCheckResult[]> {
  if (input.workflow.status !== "pass") {
    return [];
  }

  const configDiagnostics = buildPriorityConfigDiagnostics(
    input.workflow.workflow
  );
  const checks = configDiagnostics.map((diagnostic) =>
    warnCheck(
      "priority_mapping",
      diagnostic.title,
      diagnostic.summary,
      diagnostic.remediation,
      diagnostic.details
    )
  );

  const priority = input.workflow.workflow.tracker.priority;
  const parsedWorkflow = input.workflow.workflow;
  if (
    input.workflow.workflow.tracker.kind !== "github-project" ||
    !priority ||
    priority.source === "disabled"
  ) {
    if (checks.length === 0) {
      checks.push(
        passCheck(
          "priority_mapping",
          "Priority mapping",
          priority?.source === "disabled"
            ? "Explicit priority mapping is disabled; dispatch priority resolves to null."
            : "No explicit priority mapping drift checks are required.",
          { source: priority?.source ?? null }
        )
      );
    }
    return checks;
  }

  if (
    !input.auth ||
    !input.selection ||
    input.selection.kind !== "resolved" ||
    !input.projectDetail ||
    !input.projectBindingId
  ) {
    checks.push(
      warnCheck(
        "priority_mapping",
        "Priority mapping drift",
        "Live priority mapping drift checks could not run because GitHub authentication, managed project selection, or project resolution is unavailable.",
        "Fix the prerequisite doctor checks, then re-run 'gh-symphony doctor'.",
        {
          blockedBy: [
            ...(!input.auth ? ["gh_authentication"] : []),
            ...(!input.selection || input.selection.kind !== "resolved"
              ? ["managed_project"]
              : []),
            ...(!input.projectDetail || !input.projectBindingId
              ? ["github_project_resolution"]
              : []),
          ],
        }
      )
    );
    return checks;
  }

  const client = input.deps.createClient(input.auth.token, {
    apiUrl: input.selection.projectConfig.tracker.apiUrl,
  });
  let repositoryLabels: Array<{ repository: string; labels: string[] }> | null =
    priority.source === "labels" ? [] : null;
  if (priority.source === "labels") {
    try {
      repositoryLabels = await Promise.all(
        input.projectDetail.linkedRepositories.map(async (repository) => ({
          repository: `${repository.owner}/${repository.name}`,
          labels: (
            await input.deps.listRepositoryLabels(
              client,
              repository.owner,
              repository.name
            )
          ).map((label) => label.name),
        }))
      );
    } catch (error) {
      checks.push(
        warnCheck(
          "priority_mapping",
          "Priority label drift",
          "Live repository labels could not be read for priority mapping drift checks.",
          "Confirm GitHub token repository access and re-run 'gh-symphony doctor'.",
          { error: formatSmokeError(error) }
        )
      );
      repositoryLabels = null;
    }
  }

  let activeIssues: TrackedIssue[] = [];
  try {
    const trackerConfig = buildGithubTrackerConfig({
      projectConfig: input.selection,
      bindingId: input.projectBindingId,
      token: input.auth.token,
      workflow: input.workflow.workflow,
    });
    activeIssues = (await input.deps.fetchProjectIssues(trackerConfig)).filter(
      (issue) => isActiveSmokeIssue(issue, parsedWorkflow)
    );
  } catch (error) {
    checks.push(
      warnCheck(
        "priority_mapping",
        "Active priority drift",
        "Active issues could not be read for priority mapping drift checks.",
        "Confirm GitHub token scopes, project visibility, and network access, then re-run 'gh-symphony doctor'.",
        { error: formatSmokeError(error) }
      )
    );
  }

  const driftDiagnostics = buildPriorityDriftDiagnostics({
    workflow: parsedWorkflow,
    projectDetail: input.projectDetail,
    repositoryLabels,
    activeIssues,
  });
  checks.push(
    ...driftDiagnostics.map((diagnostic) =>
      warnCheck(
        "priority_mapping",
        diagnostic.title,
        diagnostic.summary,
        diagnostic.remediation,
        diagnostic.details
      )
    )
  );

  if (checks.length === 0) {
    checks.push(
      passCheck(
        "priority_mapping",
        "Priority mapping",
        "Explicit priority mapping matches the live Project/repository state inspected by doctor.",
        { source: priority.source }
      )
    );
  }

  return checks;
}

function isActiveSmokeIssue(
  issue: TrackedIssue,
  workflow: ParsedWorkflow
): boolean {
  const normalized = issue.state.trim().toLowerCase();
  return workflow.lifecycle.activeStates.some(
    (state) => state.trim().toLowerCase() === normalized
  );
}

function selectRepresentativeIssue(
  issues: TrackedIssue[],
  workflow: ParsedWorkflow
): TrackedIssue | null {
  const activeIssues = issues.filter((issue) =>
    isActiveSmokeIssue(issue, workflow)
  );
  activeIssues.sort((a, b) => {
    const left = a.updatedAt ?? a.createdAt ?? "";
    const right = b.updatedAt ?? b.createdAt ?? "";
    return right.localeCompare(left);
  });
  return activeIssues[0] ?? null;
}

function isRepositoryConfigured(
  projectConfig: ResolvedManagedProjectSelection,
  owner: string,
  name: string
): boolean {
  const repositories = [projectConfig.projectConfig.repository].filter(
    (repository): repository is NonNullable<typeof repository> =>
      Boolean(repository?.owner && repository.name)
  );
  const normalizedOwner = owner.trim().toLowerCase();
  const normalizedName = name.trim().toLowerCase();
  return repositories.some(
    (repo) =>
      repo.owner.trim().toLowerCase() === normalizedOwner &&
      repo.name.trim().toLowerCase() === normalizedName
  );
}

function isHookPathLike(command: string): boolean {
  const trimmed = command.trim();
  return (
    trimmed.length > 0 &&
    !trimmed.includes("\n") &&
    !/\s/.test(trimmed) &&
    (trimmed.startsWith("/") ||
      trimmed.startsWith("./") ||
      trimmed.startsWith("../") ||
      trimmed.includes("/") ||
      trimmed.includes("\\"))
  );
}

async function buildHookChecks(
  repoRoot: string,
  workflow: ParsedWorkflow,
  deps: Pick<DoctorDependencies, "access">
): Promise<DoctorCheckResult[]> {
  const hooks = [
    ["after_create", workflow.hooks.afterCreate],
    ["before_run", workflow.hooks.beforeRun],
    ["after_run", workflow.hooks.afterRun],
    ["before_remove", workflow.hooks.beforeRemove],
  ] as const;
  const configured = hooks.filter(([, command]) => command);

  if (configured.length === 0) {
    return [
      passCheck(
        "workflow_hooks",
        "Workflow hook paths",
        "No WORKFLOW.md hooks are configured.",
        { configured: 0 }
      ),
    ];
  }

  const unresolved: Array<{ hook: string; command: string; path: string }> = [];
  const checked: Array<{ hook: string; command: string; path: string }> = [];
  let inline = 0;

  for (const [hook, command] of configured) {
    if (!command || !isHookPathLike(command)) {
      inline += 1;
      continue;
    }
    const path = isAbsolute(command) ? command : resolve(repoRoot, command);
    try {
      await deps.access(path, constants.F_OK);
      checked.push({ hook, command, path });
    } catch {
      unresolved.push({ hook, command, path });
    }
  }

  if (unresolved.length > 0) {
    return [
      failCheck(
        "workflow_hooks",
        "Workflow hook paths",
        `Unresolved WORKFLOW.md hook path${unresolved.length === 1 ? "" : "s"}: ${unresolved.map((entry) => `${entry.hook}=${entry.command}`).join(", ")}.`,
        "Create the referenced hook script(s), fix the hook path(s), or replace them with inline commands.",
        {
          configured: configured.length,
          pathsChecked: checked.length,
          inline,
          unresolved,
          checked,
        }
      ),
    ];
  }

  const pathSummary =
    checked.length === 0
      ? "No hook paths required filesystem validation."
      : `Resolved ${checked.length} WORKFLOW.md hook path${checked.length === 1 ? "" : "s"}.`;
  const inlineSummary =
    inline === 0
      ? ""
      : ` Treated ${inline} hook${inline === 1 ? "" : "s"} as inline command${inline === 1 ? "" : "s"}.`;

  return [
    passCheck(
      "workflow_hooks",
      "Workflow hook paths",
      `${pathSummary}${inlineSummary}`,
      {
        configured: configured.length,
        pathsChecked: checked.length,
        inline,
        checked,
      }
    ),
  ];
}

function formatSmokeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function buildDoctorSmokeChecks(input: {
  auth: ResolvedGitHubAuth | null;
  selection: Awaited<ReturnType<typeof inspectManagedProjectSelection>>;
  workflow: WorkflowCheckState;
  projectDetail: ProjectDetail | null;
  projectBindingId: string | null;
  repoRoot: string;
  options: GlobalOptions;
  parsedArgs: ParsedDoctorArgs;
  deps: DoctorDependencies;
}): Promise<DoctorCheckResult[]> {
  const checks: DoctorCheckResult[] = [];

  if (input.selection.kind !== "resolved") {
    checks.push(
      failCheck(
        "smoke_issue",
        "Smoke target issue",
        "Smoke check could not choose an issue because managed project selection failed.",
        "Fix the managed project selection check first, then re-run 'gh-symphony doctor --smoke'.",
        { blockedBy: "managed_project" }
      )
    );
    return checks;
  }

  if (!input.auth) {
    checks.push(
      failCheck(
        "smoke_issue",
        "Smoke target issue",
        "Smoke check could not read live issues because GitHub authentication failed.",
        "Fix GitHub authentication first, then re-run 'gh-symphony doctor --smoke'.",
        { blockedBy: "gh_authentication" }
      )
    );
    return checks;
  }

  if (input.workflow.status !== "pass") {
    checks.push(
      failCheck(
        "smoke_issue",
        "Smoke target issue",
        "Smoke check could not read a live issue because WORKFLOW.md is missing or invalid.",
        "Fix WORKFLOW.md first, then re-run 'gh-symphony doctor --smoke'.",
        { blockedBy: "workflow_file" }
      )
    );
    return checks;
  }

  if (!input.projectBindingId || !input.projectDetail) {
    checks.push(
      failCheck(
        "smoke_issue",
        "Smoke target issue",
        "Smoke check could not read live issues because the GitHub Project binding did not resolve.",
        "Fix the GitHub project resolution check first, then re-run 'gh-symphony doctor --smoke'.",
        { blockedBy: "github_project_resolution" }
      )
    );
    return checks;
  }

  const trackerConfig = buildGithubTrackerConfig({
    projectConfig: input.selection,
    bindingId: input.projectBindingId,
    token: input.auth.token,
    workflow: input.workflow.workflow,
  });

  let issue: TrackedIssue | null = null;
  if (input.parsedArgs.issue) {
    let issueRef: ReturnType<typeof parseIssueReference>;
    try {
      issueRef = parseIssueReference(input.parsedArgs.issue);
    } catch (error) {
      checks.push(
        failCheck(
          "smoke_issue",
          "Smoke target issue",
          `Smoke check issue reference is invalid: ${input.parsedArgs.issue}.`,
          "Use the expected '--issue owner/repo#number' format and re-run the smoke check.",
          {
            issue: input.parsedArgs.issue,
            expectedFormat: "owner/repo#number",
            error: formatSmokeError(error),
          }
        )
      );
      return checks;
    }

    if (
      !findLinkedRepository(input.projectDetail, issueRef.owner, issueRef.name)
    ) {
      checks.push(
        failCheck(
          "project_repository_link",
          "Project repository link",
          `Repository ${issueRef.owner}/${issueRef.name} is not linked to GitHub Project "${input.projectDetail.title}".`,
          "Run 'gh-symphony setup' from inside the target repository, or run 'gh-symphony workflow init' followed by 'gh-symphony repo init'.",
          {
            repository: `${issueRef.owner}/${issueRef.name}`,
            projectTitle: input.projectDetail.title,
          }
        )
      );
    } else if (
      !isRepositoryConfigured(input.selection, issueRef.owner, issueRef.name)
    ) {
      checks.push(
        failCheck(
          "project_repository_link",
          "Project repository link",
          `Repository ${issueRef.owner}/${issueRef.name} is linked to the GitHub Project but is not configured locally.`,
          "Run 'gh-symphony repo init' from the target repository before running start.",
          { repository: `${issueRef.owner}/${issueRef.name}` }
        )
      );
    } else {
      checks.push(
        passCheck(
          "project_repository_link",
          "Project repository link",
          `Repository ${issueRef.owner}/${issueRef.name} is linked to the GitHub Project and configured locally.`,
          { repository: `${issueRef.owner}/${issueRef.name}` }
        )
      );
    }

    try {
      issue = await input.deps.fetchProjectIssue(
        trackerConfig,
        { owner: issueRef.owner, name: issueRef.name },
        issueRef.number
      );
    } catch (error) {
      checks.push(
        failCheck(
          "smoke_issue",
          "Smoke target issue",
          `Smoke check could not read issue ${issueRef.identifier}.`,
          "Confirm GitHub token scopes, project visibility, and network access, then re-run the smoke check.",
          { issue: issueRef.identifier, error: formatSmokeError(error) }
        )
      );
      return checks;
    }

    if (!issue) {
      checks.push(
        failCheck(
          "smoke_issue",
          "Smoke target issue",
          `Issue ${issueRef.identifier} is not in the configured GitHub Project or is not readable.`,
          "Add the issue to the project, confirm the token can read it, and re-run the smoke check.",
          { issue: issueRef.identifier }
        )
      );
      return checks;
    }
  } else {
    let issues: TrackedIssue[];
    try {
      issues = await input.deps.fetchProjectIssues(trackerConfig);
    } catch (error) {
      checks.push(
        failCheck(
          "smoke_issue",
          "Smoke target issue",
          `Smoke check could not read live issues from GitHub Project "${input.projectDetail.title}".`,
          "Confirm GitHub token scopes, project visibility, and network access, then re-run the smoke check.",
          {
            projectTitle: input.projectDetail.title,
            error: formatSmokeError(error),
          }
        )
      );
      return checks;
    }

    issue = selectRepresentativeIssue(issues, input.workflow.workflow);
    if (!issue) {
      checks.push(
        failCheck(
          "smoke_issue",
          "Smoke target issue",
          `No active live issue was found in GitHub Project "${input.projectDetail.title}".`,
          `Move one issue into an active state (${input.workflow.workflow.lifecycle.activeStates.join(", ")}) or re-run with '--issue owner/repo#number'.`,
          {
            projectTitle: input.projectDetail.title,
            activeStates: input.workflow.workflow.lifecycle.activeStates,
          }
        )
      );
      return checks;
    }
  }

  const repositoryName = `${issue.repository.owner}/${issue.repository.name}`;
  if (!checks.some((check) => check.id === "project_repository_link")) {
    if (
      !findLinkedRepository(
        input.projectDetail,
        issue.repository.owner,
        issue.repository.name
      )
    ) {
      checks.push(
        failCheck(
          "project_repository_link",
          "Project repository link",
          `Repository ${repositoryName} is not linked to GitHub Project "${input.projectDetail.title}".`,
          "Run 'gh-symphony setup' from inside the target repository, or run 'gh-symphony workflow init' followed by 'gh-symphony repo init'.",
          {
            repository: repositoryName,
            projectTitle: input.projectDetail.title,
          }
        )
      );
    } else if (
      !isRepositoryConfigured(
        input.selection,
        issue.repository.owner,
        issue.repository.name
      )
    ) {
      checks.push(
        failCheck(
          "project_repository_link",
          "Project repository link",
          `Repository ${repositoryName} is linked to the GitHub Project but is not configured locally.`,
          "Run 'gh-symphony repo init' from the target repository before running start.",
          { repository: repositoryName }
        )
      );
    } else {
      checks.push(
        passCheck(
          "project_repository_link",
          "Project repository link",
          `Repository ${repositoryName} is linked to the GitHub Project and configured locally.`,
          { repository: repositoryName }
        )
      );
    }
  }

  checks.push(
    passCheck(
      "smoke_issue",
      "Smoke target issue",
      `Using live issue ${issue.identifier} (${issue.state}).`,
      {
        issue: issue.identifier,
        state: issue.state,
        source: input.parsedArgs.issue ? "explicit" : "auto",
      }
    )
  );

  try {
    const renderedPrompt = renderIssueWorkflowPreview({
      workflow: input.workflow.workflow,
      issue,
      attempt: null,
    });
    checks.push(
      passCheck(
        "workflow_prompt_render",
        "Workflow prompt render",
        `WORKFLOW.md rendered successfully for ${issue.identifier}.`,
        {
          issue: issue.identifier,
          promptLength: renderedPrompt.length,
          workflowPath: input.workflow.workflowPath,
        }
      )
    );
  } catch (error) {
    checks.push(
      failCheck(
        "workflow_prompt_render",
        "Workflow prompt render",
        `WORKFLOW.md failed to render for ${issue.identifier}.`,
        "Fix the prompt template variables or run 'gh-symphony workflow preview --issue ...' for a detailed preview error.",
        {
          issue: issue.identifier,
          error: error instanceof Error ? error.message : String(error),
        }
      )
    );
  }

  checks.push(
    ...(await buildHookChecks(
      input.repoRoot,
      input.workflow.workflow,
      input.deps
    ))
  );

  return checks;
}

export async function runDoctorDiagnostics(
  options: GlobalOptions,
  args: string[],
  dependencies: Partial<DoctorDependencies> = {}
): Promise<DoctorReport> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const parsedArgs = parseDoctorArgs(args);
  if (parsedArgs.error) {
    throw new Error(`${parsedArgs.error}\n${DOCTOR_USAGE}`);
  }
  const repoRoot = process.cwd();

  const checks: DoctorCheckResult[] = [];
  let auth: ResolvedGitHubAuth | null = null;
  let tokenError: string | null = null;
  let authSource: GitHubAuthSource | null = null;
  let authLogin: string | null = null;
  let envTokenError: string | null = null;
  let resolvedProjectId: string | null = null;
  let resolvedProjectConfig: Awaited<
    ReturnType<typeof inspectManagedProjectSelection>
  > | null = null;
  let resolvedGithubProjectDetail: ProjectDetail | null = null;
  let resolvedGithubProjectBindingId: string | null = null;
  const envToken = deps.getEnvGitHubToken();

  const currentNodeVersion = deps.processVersion;
  const currentNodeMajor = parseMajorNodeVersion(currentNodeVersion);
  if (currentNodeMajor !== null && currentNodeMajor >= MINIMUM_NODE_MAJOR) {
    checks.push(
      passCheck(
        "node_runtime",
        "Node.js runtime",
        `Node.js ${currentNodeVersion} satisfies the minimum supported version ${MINIMUM_NODE_VERSION}.`,
        {
          currentVersion: currentNodeVersion,
          minimumVersion: MINIMUM_NODE_VERSION,
        }
      )
    );
  } else {
    checks.push(
      failCheck(
        "node_runtime",
        "Node.js runtime",
        `Node.js ${currentNodeVersion} does not satisfy the minimum supported version ${MINIMUM_NODE_VERSION}.`,
        `Install Node.js ${MINIMUM_NODE_VERSION} or newer and re-run 'gh-symphony doctor'.`,
        {
          currentVersion: currentNodeVersion,
          minimumVersion: MINIMUM_NODE_VERSION,
        }
      )
    );
  }

  const gitInstallation = await checkGitInstallation(deps);
  if (gitInstallation.installed) {
    checks.push(
      passCheck(
        "git_installation",
        "Git installation",
        `Git is installed: ${gitInstallation.version}.`,
        { version: gitInstallation.version }
      )
    );
  } else {
    checks.push(
      failCheck(
        "git_installation",
        "Git installation",
        gitInstallation.error
          ? `Git could not be executed successfully from PATH: ${gitInstallation.error}.`
          : "Git could not be found on PATH.",
        "Install Git, confirm 'git --version' works in this shell, and re-run 'gh-symphony doctor'.",
        gitInstallation.error ? { error: gitInstallation.error } : undefined
      )
    );
  }

  const ghInstalled = deps.checkGhInstalled();
  if (ghInstalled) {
    checks.push(
      passCheck(
        "gh_installation",
        "gh CLI installation",
        "gh CLI is installed."
      )
    );
  } else if (envToken) {
    checks.push(
      passCheck(
        "gh_installation",
        "gh CLI installation",
        "gh CLI is not installed, but GITHUB_GRAPHQL_TOKEN is configured so gh is optional.",
        { authSource: "env" }
      )
    );
  } else {
    checks.push(
      failCheck(
        "gh_installation",
        "gh CLI installation",
        "gh CLI is not installed.",
        "Install GitHub CLI from https://cli.github.com and re-run 'gh-symphony doctor'."
      )
    );
  }

  const ghAuth = ghInstalled
    ? deps.checkGhAuthenticated()
    : { authenticated: false };
  const ghScopes =
    ghInstalled && ghAuth.authenticated
      ? deps.checkGhScopes()
      : { valid: false, missing: [...REQUIRED_GH_SCOPES], scopes: [] };

  if (envToken) {
    try {
      auth = await deps.validateGitHubToken(envToken, "env");
    } catch (error) {
      envTokenError =
        error instanceof Error
          ? error.message
          : "Unknown token validation error.";
    }
  }

  if (!auth && ghInstalled && ghAuth.authenticated && ghScopes.valid) {
    try {
      const ghToken = deps.getGhToken({ allowEnv: false });
      auth = await deps.validateGitHubToken(ghToken, "gh");
    } catch (error) {
      tokenError =
        error instanceof Error
          ? error.message
          : "Unknown token retrieval error.";
    }
  }

  if (auth) {
    authSource = auth.source;
    authLogin = auth.login;
    checks.push(
      passCheck(
        "gh_authentication",
        "GitHub authentication",
        `Using ${formatAuthSource(auth.source)} as ${auth.login}.`,
        { authSource: auth.source, login: auth.login }
      )
    );
  } else if (envTokenError) {
    checks.push(
      failCheck(
        "gh_authentication",
        "GitHub authentication",
        "Configured GITHUB_GRAPHQL_TOKEN could not be used.",
        `${envTokenError} Fix GITHUB_GRAPHQL_TOKEN or configure gh auth, then re-run the doctor command.`,
        { authSource: "env", error: envTokenError }
      )
    );
  } else {
    checks.push(
      failCheck(
        "gh_authentication",
        "GitHub authentication",
        "gh auth status failed or no GitHub login is configured.",
        `Run 'gh auth login --scopes ${REQUIRED_GH_SCOPES.join(",")}' and re-run the doctor command.`
      )
    );
  }

  if (auth) {
    checks.push(
      passCheck(
        "gh_scopes",
        "GitHub token scopes",
        `Required scopes are present via ${formatAuthSource(auth.source)}: ${REQUIRED_GH_SCOPES.join(", ")}.`,
        { authSource: auth.source, scopes: auth.scopes }
      )
    );
  } else if (envTokenError) {
    checks.push(
      failCheck(
        "gh_scopes",
        "GitHub token scopes",
        envTokenError,
        "Update GITHUB_GRAPHQL_TOKEN to include repo, read:org, and project, or configure gh auth with the same scopes.",
        { authSource: "env" }
      )
    );
  } else {
    const missingScopes =
      ghInstalled && ghAuth.authenticated
        ? ghScopes.missing
        : [...REQUIRED_GH_SCOPES];
    checks.push(
      failCheck(
        "gh_scopes",
        "GitHub token scopes",
        `Missing required scopes: ${missingScopes.join(", ")}.`,
        `Run 'gh auth refresh --scopes ${REQUIRED_GH_SCOPES.join(",")}' and confirm 'gh auth status' shows the updated scopes.`,
        { missing: missingScopes, scopes: ghScopes.scopes }
      )
    );
  }

  resolvedProjectConfig = await deps.inspectManagedProjectSelection({
    configDir: options.configDir,
    requestedProjectId: parsedArgs.projectId,
  });
  if (resolvedProjectConfig.kind === "resolved") {
    resolvedProjectId = resolvedProjectConfig.projectId;
    checks.push(
      passCheck(
        "managed_project",
        "Managed project selection",
        `Resolved managed project "${resolvedProjectConfig.projectId}".`,
        {
          projectId: resolvedProjectConfig.projectId,
          workspaceDir: resolvedProjectConfig.projectConfig.workspaceDir,
        }
      )
    );
  } else {
    checks.push(
      failCheck(
        "managed_project",
        "Managed project selection",
        resolvedProjectConfig.message,
        "Run 'gh-symphony repo init' from the target repository.",
        {
          reason: resolvedProjectConfig.kind,
          ...(resolvedProjectConfig.projectId
            ? { projectId: resolvedProjectConfig.projectId }
            : {}),
        }
      )
    );
  }

  if (resolvedProjectConfig.kind === "resolved" && !auth) {
    checks.push(
      failCheck(
        "github_project_resolution",
        "GitHub project resolution",
        tokenError
          ? "GitHub project resolution could not run because the GitHub token could not be retrieved."
          : envTokenError
            ? "GitHub project resolution could not run because the configured GITHUB_GRAPHQL_TOKEN could not be used."
            : "GitHub project resolution could not run because authentication failed.",
        tokenError
          ? "Check the local keychain or environment used by 'gh auth token', then re-run 'gh-symphony doctor'."
          : envTokenError
            ? "Fix GITHUB_GRAPHQL_TOKEN or gh authentication first, then re-run 'gh-symphony doctor'."
            : "Fix the GitHub authentication check first, then re-run 'gh-symphony doctor'.",
        tokenError || envTokenError
          ? {
              error: tokenError ?? envTokenError,
              ...(authSource ? { authSource } : {}),
            }
          : undefined
      )
    );
  } else if (
    resolvedProjectConfig.kind === "resolved" &&
    !readGitHubProjectBinding(resolvedProjectConfig.projectConfig)
  ) {
    checks.push(
      failCheck(
        "github_project_resolution",
        "GitHub project resolution",
        `Managed project "${resolvedProjectConfig.projectId}" is not bound to a GitHub Project.`,
        "Run 'gh-symphony workflow init' to select a valid GitHub Project binding, then run 'gh-symphony repo init' again.",
        {
          reason: "missing_binding" satisfies ProjectResolutionReason,
          projectId: resolvedProjectConfig.projectId,
        }
      )
    );
  } else if (
    auth &&
    resolvedProjectConfig.kind === "resolved" &&
    readGitHubProjectBinding(resolvedProjectConfig.projectConfig)
  ) {
    try {
      const bindingId = readGitHubProjectBinding(
        resolvedProjectConfig.projectConfig
      );
      if (!bindingId) {
        throw new Error("Managed project is not bound to a GitHub Project.");
      }
      resolvedGithubProjectBindingId = bindingId;
      const client = deps.createClient(auth.token);
      const detail = await deps.getProjectDetail(client, bindingId);
      resolvedGithubProjectDetail = detail;
      checks.push(
        passCheck(
          "github_project_resolution",
          "GitHub project resolution",
          `Resolved GitHub Project "${detail.title}".`,
          {
            bindingId: resolvedGithubProjectBindingId,
            url: detail.url,
          }
        )
      );
    } catch (error) {
      const message =
        error instanceof GitHubApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : "Unknown GitHub API error.";
      checks.push(
        failCheck(
          "github_project_resolution",
          "GitHub project resolution",
          `Failed to resolve configured project binding '${resolvedGithubProjectBindingId}'.`,
          "Run 'gh-symphony workflow init' to select a valid GitHub Project, then run 'gh-symphony repo init' again.",
          {
            reason: "api_error" satisfies ProjectResolutionReason,
            bindingId: resolvedGithubProjectBindingId,
            error: message,
          }
        )
      );
    }
  } else {
    checks.push(
      failCheck(
        "github_project_resolution",
        "GitHub project resolution",
        "GitHub project resolution could not run because managed project selection failed.",
        "Fix the managed project selection check first, then re-run 'gh-symphony doctor'.",
        {
          reason: "selection_failed" satisfies ProjectResolutionReason,
        }
      )
    );
  }

  const configDirState = await inspectPathState(options.configDir, deps);
  checks.push(
    buildPathCheck(
      "config_directory",
      "Config directory",
      options.configDir,
      configDirState,
      formatEnsureDirectoryCommand(options.configDir, deps.platform),
      `Ensure your user can write to '${options.configDir}'.`
    )
  );

  const runtimeRoot = resolveRuntimeRoot(options.configDir);
  const runtimeRootState = await inspectPathState(runtimeRoot, deps);
  checks.push(
    buildPathCheck(
      "runtime_root",
      "Runtime root",
      runtimeRoot,
      runtimeRootState,
      formatEnsureDirectoryCommand(runtimeRoot, deps.platform),
      `Ensure your user can write to '${runtimeRoot}'.`
    )
  );

  if (resolvedProjectConfig.kind === "resolved") {
    const workspaceDir = resolvedProjectConfig.projectConfig.workspaceDir;
    const workspaceState = await inspectPathState(workspaceDir, deps);
    checks.push(
      buildPathCheck(
        "workspace_root",
        "Workspace root",
        workspaceDir,
        workspaceState,
        formatEnsureDirectoryCommand(workspaceDir, deps.platform),
        "Update the managed project workspaceDir to a writable path or fix the filesystem permissions."
      )
    );
  } else {
    checks.push(
      failCheck(
        "workspace_root",
        "Workspace root",
        "Workspace root could not be checked because no managed project was resolved.",
        "Fix the managed project selection check first, then re-run 'gh-symphony doctor'.",
        { blockedBy: "managed_project" }
      )
    );
  }

  const workflow = await checkWorkflow(process.cwd(), deps);
  if (workflow.status === "pass") {
    checks.push(
      passCheck(
        "workflow_file",
        "Repository WORKFLOW.md",
        `WORKFLOW.md parsed successfully (${workflow.format}).`,
        { path: workflow.workflowPath, format: workflow.format }
      )
    );
  } else {
    checks.push(
      failCheck(
        "workflow_file",
        "Repository WORKFLOW.md",
        workflow.summary,
        workflow.remediation,
        {
          path: workflow.workflowPath,
          reason: workflow.reason,
          ...(workflow.error ? { error: workflow.error } : {}),
        }
      )
    );
  }

  if (workflow.status === "pass") {
    const binary = resolveRuntimeCommandBinary(workflow.command);
    if (binary && (await commandExistsOnPath(binary, deps))) {
      checks.push(
        passCheck(
          "runtime_command",
          "Runtime command detection",
          `Configured runtime command is available: ${binary}.`,
          { command: workflow.command, binary }
        )
      );
    } else {
      checks.push(
        failCheck(
          "runtime_command",
          "Runtime command detection",
          `Configured runtime command could not be found on PATH: ${workflow.command}.`,
          buildRuntimeInstallGuidance(binary, deps.platform),
          { command: workflow.command, binary }
        )
      );
    }

    if (isClaudeRuntimeCommand(workflow.command)) {
      const claudePreflight = await runClaudePreflight(
        {
          cwd: process.cwd(),
          env: process.env,
          command: resolveClaudeCommandBinary(workflow.command) ?? undefined,
          includeGhAuth: false,
        },
        {
          execFileSync: deps.execFileSync,
          readFile: deps.readFile,
          access: deps.access,
          fetchImpl: deps.fetchImpl,
          platform: deps.platform,
        }
      );
      checks.push(...claudePreflight.checks.map(toDoctorClaudeCheck));
    }
  } else {
    checks.push(
      failCheck(
        "runtime_command",
        "Runtime command detection",
        "Runtime command detection could not run because WORKFLOW.md is missing or invalid.",
        "Fix the WORKFLOW.md check first so the configured runtime command can be validated.",
        { blockedBy: "workflow_file" }
      )
    );
  }

  checks.push(
    ...(await buildPriorityMappingChecks({
      auth,
      selection: resolvedProjectConfig,
      workflow,
      projectDetail: resolvedGithubProjectDetail,
      projectBindingId: resolvedGithubProjectBindingId,
      deps,
    }))
  );

  if (parsedArgs.smoke) {
    checks.push(
      ...(await buildDoctorSmokeChecks({
        auth,
        selection: resolvedProjectConfig,
        workflow,
        projectDetail: resolvedGithubProjectDetail,
        projectBindingId: resolvedGithubProjectBindingId,
        repoRoot,
        options,
        parsedArgs,
        deps,
      }))
    );
  }

  return {
    ok: checks.every((check) => check.status !== "fail"),
    checkedAt: new Date().toISOString(),
    configDir: options.configDir,
    projectId: resolvedProjectId,
    authSource,
    authLogin,
    checks,
  };
}

function buildRuntimeInstallGuidance(
  binary: string | null | undefined,
  platform: NodeJS.Platform
): string {
  if (binary === "codex") {
    return "Install Codex CLI using its official installation instructions and ensure 'codex' is on PATH.";
  }

  if (binary === "claude" || binary === "claude-code") {
    return "Install Claude Code using its official installation instructions and ensure the runtime binary is on PATH.";
  }

  if (platform === "win32" && binary) {
    return `Install '${binary}' using its official installation instructions and ensure the directory containing '${binary}.exe' is on PATH.`;
  }

  if (binary) {
    return `Install '${binary}' using its official installation instructions and ensure it is available on PATH.`;
  }

  return "Install the configured runtime command using its official installation instructions and ensure it is available on PATH.";
}

function isInteractiveTerminal(
  deps: Pick<DoctorDependencies, "stdinIsTTY" | "stdoutIsTTY">
): boolean {
  return deps.stdinIsTTY && deps.stdoutIsTTY;
}

function runCliRemediation(
  title: string,
  checkId: DoctorCheckId,
  args: string[],
  deps: Pick<
    DoctorDependencies,
    | "spawnSync"
    | "execPath"
    | "cliArgv"
    | "stdinIsTTY"
    | "stdoutIsTTY"
    | "platform"
  >,
  options: Pick<GlobalOptions, "configDir">,
  interactive: boolean,
  details?: Record<string, unknown>
): DoctorRemediationStep {
  const command = formatGhSymphonyCommand(args, deps, options);

  if (!interactive) {
    return remediationStep(
      `remediate_${checkId}`,
      checkId,
      title,
      "manual",
      `Interactive terminal not available. Run this command manually: ${command}.`,
      command,
      details
    );
  }

  const cliEntry = deps.cliArgv[1];
  if (!cliEntry) {
    return remediationStep(
      `remediate_${checkId}`,
      checkId,
      title,
      "manual",
      `Could not determine the current CLI entrypoint. Run this command manually: ${command}.`,
      command,
      details
    );
  }

  const result = deps.spawnSync(
    deps.execPath,
    [cliEntry, "--config", options.configDir, ...args],
    {
      stdio: "inherit",
    }
  );
  if ((result.status ?? 1) === 0) {
    return remediationStep(
      `remediate_${checkId}`,
      checkId,
      title,
      "applied",
      `Executed: ${command}.`,
      command,
      details
    );
  }

  return remediationStep(
    `remediate_${checkId}`,
    checkId,
    title,
    "manual",
    `Failed to complete this command automatically. Re-run it manually: ${command}.`,
    command,
    details
  );
}

async function ensureDirectoryRemediation(
  check: DoctorCheckResult,
  deps: Pick<DoctorDependencies, "mkdir" | "access" | "stat" | "platform">
): Promise<DoctorRemediationStep> {
  const pathValue =
    typeof check.details?.path === "string" ? check.details.path : null;
  const reason =
    typeof check.details?.reason === "string" ? check.details.reason : null;
  const command =
    pathValue === null
      ? undefined
      : formatEnsureDirectoryCommand(pathValue, deps.platform);

  if (!pathValue) {
    return remediationStep(
      `remediate_${check.id}`,
      check.id,
      check.title,
      "manual",
      "No filesystem path was recorded for this failing check.",
      command
    );
  }

  if (reason === "not_directory") {
    return remediationStep(
      `remediate_${check.id}`,
      check.id,
      check.title,
      "manual",
      `A file already exists at '${pathValue}'. Remove or move it before creating the directory.`,
      command,
      { path: pathValue }
    );
  }

  try {
    await deps.mkdir(pathValue, { recursive: true });
    await deps.access(pathValue, constants.W_OK);
    const target = await deps.stat(pathValue);
    if (!target.isDirectory()) {
      return remediationStep(
        `remediate_${check.id}`,
        check.id,
        check.title,
        "manual",
        `Created path '${pathValue}', but it is not a directory.`,
        command,
        { path: pathValue }
      );
    }

    return remediationStep(
      `remediate_${check.id}`,
      check.id,
      check.title,
      "applied",
      `Ensured writable directory '${pathValue}'.`,
      command,
      { path: pathValue }
    );
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "unknown error";
    const summary =
      reason === "not_writable"
        ? `Directory '${pathValue}' exists but is not writable. Update its permissions or choose a writable location: ${errorMessage}.`
        : `Failed to create '${pathValue}' automatically: ${errorMessage}.`;
    return remediationStep(
      `remediate_${check.id}`,
      check.id,
      check.title,
      "manual",
      summary,
      command,
      { path: pathValue }
    );
  }
}

async function runDoctorFixes(
  report: DoctorReport,
  deps: DoctorDependencies,
  options: Pick<GlobalOptions, "configDir" | "json">
): Promise<DoctorRemediationStep[]> {
  const steps: DoctorRemediationStep[] = [];
  const interactive = !options.json && isInteractiveTerminal(deps);
  const failed = new Map(
    report.checks
      .filter((check) => check.status === "fail")
      .map((check) => [check.id, check] as const)
  );

  for (const check of report.checks) {
    if (check.status !== "fail") {
      continue;
    }

    switch (check.id) {
      case "gh_installation":
        steps.push(
          remediationStep(
            "remediate_gh_installation",
            check.id,
            check.title,
            "manual",
            "Install GitHub CLI first. Automatic installation is not attempted by doctor.",
            "https://cli.github.com"
          )
        );
        break;
      case "gh_authentication": {
        if (failed.has("gh_installation")) {
          steps.push(
            remediationStep(
              "remediate_gh_authentication",
              check.id,
              check.title,
              "skipped",
              "Skipped because gh CLI is not installed."
            )
          );
          break;
        }
        const result = deps.runGhAuthLogin({
          spawnImpl: deps.spawnSync,
          interactive,
        });
        steps.push(
          remediationStep(
            "remediate_gh_authentication",
            check.id,
            check.title,
            result.status,
            result.summary,
            result.command
          )
        );
        break;
      }
      case "gh_scopes": {
        if (failed.has("gh_installation") || failed.has("gh_authentication")) {
          steps.push(
            remediationStep(
              "remediate_gh_scopes",
              check.id,
              check.title,
              "skipped",
              "Skipped because gh installation/authentication must be fixed first."
            )
          );
          break;
        }
        const result = deps.runGhAuthRefresh({
          spawnImpl: deps.spawnSync,
          interactive,
        });
        steps.push(
          remediationStep(
            "remediate_gh_scopes",
            check.id,
            check.title,
            result.status,
            result.summary,
            result.command,
            check.details
          )
        );
        break;
      }
      case "managed_project":
        if (check.details?.reason === "multiple_projects_require_selection") {
          steps.push(
            runCliRemediation(
              "Repository runtime setup",
              check.id,
              ["repo", "init"],
              deps,
              options,
              interactive,
              check.details
            )
          );
          break;
        }
        steps.push(
          runCliRemediation(
            "Repository runtime setup",
            check.id,
            ["repo", "init"],
            deps,
            options,
            interactive,
            check.details
          )
        );
        break;
      case "github_project_resolution": {
        if (failed.has("managed_project")) {
          steps.push(
            remediationStep(
              "remediate_github_project_resolution",
              check.id,
              check.title,
              "skipped",
              "Skipped because managed project selection must be fixed first."
            )
          );
          break;
        }
        const reason =
          typeof check.details?.reason === "string"
            ? check.details.reason
            : null;
        if (reason === "missing_binding" || reason === "api_error") {
          steps.push(
            runCliRemediation(
              "GitHub project binding setup",
              check.id,
              ["setup"],
              deps,
              options,
              interactive,
              check.details
            )
          );
          break;
        }
        steps.push(
          remediationStep(
            "remediate_github_project_resolution",
            check.id,
            check.title,
            "manual",
            check.remediation ?? "Resolve the GitHub Project binding manually.",
            formatGhSymphonyCommand(["setup"], deps, options),
            check.details
          )
        );
        break;
      }
      case "config_directory":
      case "runtime_root":
      case "workspace_root":
        if (check.details?.blockedBy === "managed_project") {
          steps.push(
            remediationStep(
              `remediate_${check.id}`,
              check.id,
              check.title,
              "skipped",
              "Skipped because managed project selection must be fixed first."
            )
          );
          break;
        }
        steps.push(await ensureDirectoryRemediation(check, deps));
        break;
      case "workflow_file": {
        const reason =
          typeof check.details?.reason === "string"
            ? check.details.reason
            : null;
        const title =
          reason === "missing"
            ? "Repository workflow initialization"
            : "Repository workflow regeneration";
        steps.push(
          runCliRemediation(
            title,
            check.id,
            ["workflow", "init"],
            deps,
            options,
            interactive,
            check.details
          )
        );
        break;
      }
      case "runtime_command": {
        if (failed.has("workflow_file")) {
          steps.push(
            remediationStep(
              "remediate_runtime_command",
              check.id,
              check.title,
              "skipped",
              "Skipped because WORKFLOW.md must be fixed first."
            )
          );
          break;
        }
        steps.push(
          remediationStep(
            "remediate_runtime_command",
            check.id,
            check.title,
            "manual",
            check.remediation ??
              "Install the configured runtime command manually.",
            typeof check.details?.binary === "string"
              ? String(check.details.binary)
              : undefined,
            check.details
          )
        );
        break;
      }
      case "claude_binary":
      case "anthropic_api_key":
      case "claude_mcp_config":
        steps.push(
          remediationStep(
            `remediate_${check.id}`,
            check.id,
            check.title,
            "manual",
            check.remediation ?? "Fix the Claude runtime readiness check.",
            undefined,
            check.details
          )
        );
        break;
    }
  }

  return steps;
}

function renderTextReport(report: DoctorReport): string {
  const lines = [
    `gh-symphony doctor`,
    `Auth source: ${report.authSource ?? "unavailable"}`,
    ...(report.authLogin
      ? [`Authenticated GitHub user: ${report.authLogin}`]
      : []),
    "",
  ];
  if (report.remediation) {
    lines.push("Remediation");
    for (const step of report.remediation.steps) {
      lines.push(`${step.status.toUpperCase()} ${step.title}`);
      lines.push(`  ${step.summary}`);
      if (step.command) {
        lines.push(`  Command: ${step.command}`);
      }
    }
    lines.push("");
  }
  for (const check of report.checks) {
    const statusLabel =
      check.status === "pass"
        ? "PASS"
        : check.status === "warn"
          ? "WARN"
          : "FAIL";
    lines.push(`${statusLabel} ${check.title}`);
    lines.push(`  ${check.summary}`);
    if (check.remediation) {
      lines.push(`  Fix: ${check.remediation}`);
    }
  }
  lines.push("");
  lines.push(
    report.ok
      ? "Doctor completed successfully."
      : "Doctor found required checks that need attention."
  );
  return lines.join("\n");
}

function renderBundleSummary(summary: SupportBundleSummary): string {
  const redactionClasses =
    summary.redactionClasses.length === 0
      ? "none"
      : summary.redactionClasses
          .map((entry) => `${entry.class}:${entry.count}`)
          .join(", ");
  return [
    "gh-symphony doctor support bundle",
    `Output path: ${summary.outputPath}`,
    `Project: ${summary.projectId}`,
    `Included artifacts: ${summary.includedCount}`,
    `Missing artifacts: ${summary.missingCount}`,
    `Redactions: ${summary.redactionCount} (${redactionClasses})`,
    `Truncations: ${summary.truncationCount}`,
    `Manifest: ${summary.manifestPath}`,
  ].join("\n");
}

export async function runDoctorCommand(
  args: string[],
  options: GlobalOptions,
  dependencies: Partial<DoctorDependencies> = {}
): Promise<void> {
  try {
    const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
    const parsedArgs = parseDoctorArgs(args);
    if (parsedArgs.error) {
      throw new Error(`${parsedArgs.error}\n${DOCTOR_USAGE}`);
    }

    const initialReport = await runDoctorDiagnostics(options, args, deps);
    if (parsedArgs.bundle) {
      if (!initialReport.projectId) {
        throw new Error(
          "Cannot create a support bundle because no managed project was resolved."
        );
      }
      const summary = await createSupportBundle({
        configDir: options.configDir,
        projectId: initialReport.projectId,
        repoRoot: process.cwd(),
        outputPath: parsedArgs.bundlePath,
        doctorReport: initialReport,
      });
      if (options.json) {
        process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
      } else {
        process.stdout.write(renderBundleSummary(summary) + "\n");
      }
      process.exitCode = initialReport.ok ? 0 : 1;
      return;
    }

    if (parsedArgs.fix) {
      const remediation = {
        attempted: true,
        steps: await runDoctorFixes(initialReport, deps, options),
      };
      const report = await runDoctorDiagnostics(
        options,
        args.filter((arg) => arg !== "--fix"),
        deps
      );
      report.remediation = remediation;
      if (options.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      } else {
        process.stdout.write(renderTextReport(report) + "\n");
      }
      process.exitCode = report.ok ? 0 : 1;
      return;
    }

    const report = initialReport;
    if (options.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    } else {
      process.stdout.write(renderTextReport(report) + "\n");
    }
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Unknown error"}\n`
    );
    process.exitCode = 2;
  }
}

const handler = async (args: string[], options: GlobalOptions): Promise<void> =>
  runDoctorCommand(args, options);

export default handler;
