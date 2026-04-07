import { constants } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { access, mkdir, readFile, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { parseWorkflowMarkdown } from "@gh-symphony/core";
import {
  createClient,
  getProjectDetail,
  GitHubApiError,
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
import { inspectManagedProjectSelection } from "../project-selection.js";

type DoctorStatus = "pass" | "fail";
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
  | "runtime_command";

type PathCheckReason = "missing" | "not_directory" | "not_writable";
type WorkflowCheckReason = "missing" | "invalid";
type ProjectResolutionReason =
  | "token_unavailable"
  | "missing_binding"
  | "api_error"
  | "selection_failed";

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
  error?: string;
};

type WorkflowCheckState =
  | {
      status: "pass";
      command: string;
      workflowPath: string;
      format: string;
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
};

const MINIMUM_NODE_MAJOR = 24;
const MINIMUM_NODE_VERSION = `v${MINIMUM_NODE_MAJOR}.0.0`;

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
  const parsed: ParsedDoctorArgs = { fix: false };

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

    if (arg?.startsWith("-")) {
      parsed.error = `Unknown option '${arg}'`;
      return parsed;
    }
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
    remediation =
      `Move or remove the conflicting file at '${targetPath}', then create the directory with: ${createCommand}.`;
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

function extractCommandBinary(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) {
    return null;
  }

  const tokens = trimmed.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  if (tokens.length === 0) {
    return null;
  }

  const shell = stripQuotes(tokens[0]!);
  if (
    (shell === "bash" || shell === "sh" || shell === "zsh" || shell === "fish") &&
    tokens.length >= 3
  ) {
    const flagIndex = tokens.findIndex((token) => {
      const value = stripQuotes(token);
      return value === "-c" || value === "-lc";
    });
    if (flagIndex >= 0 && flagIndex + 1 < tokens.length) {
      const nested = stripQuotes(tokens[flagIndex + 1]!);
      const nestedTokens = nested.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
      return nestedTokens.length > 0 ? stripQuotes(nestedTokens[0]!) : shell;
    }
  }

  return shell;
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, "");
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
      : { installed: false, error: "git --version returned an empty response." };
  } catch (error) {
    return {
      installed: false,
      error: error instanceof Error ? error.message : "Unknown Git execution error.",
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
        "Run 'gh-symphony init' in this repository or add a valid WORKFLOW.md at the repo root.",
    };
  }

  try {
    const parsed = deps.parseWorkflowMarkdown(markdown, process.env);
    return {
      status: "pass",
      command: parsed.agentCommand,
      workflowPath,
      format: parsed.format,
    };
  } catch (error) {
    return {
      status: "fail",
      reason: "invalid",
      workflowPath,
      summary: "WORKFLOW.md could not be parsed.",
      remediation:
        "Fix the WORKFLOW.md front matter or re-run 'gh-symphony init' to regenerate it.",
      error: error instanceof Error ? error.message : "Unknown workflow parse error.",
    };
  }
}

export async function runDoctorDiagnostics(
  options: GlobalOptions,
  args: string[],
  dependencies: Partial<DoctorDependencies> = {}
): Promise<DoctorReport> {
  const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
  const parsedArgs = parseDoctorArgs(args);
  if (parsedArgs.error) {
    throw new Error(
      `${parsedArgs.error}\nUsage: gh-symphony doctor [--project-id <project-id>] [--fix]`
    );
  }

  const checks: DoctorCheckResult[] = [];
  let auth: ResolvedGitHubAuth | null = null;
  let tokenError: string | null = null;
  let authSource: GitHubAuthSource | null = null;
  let authLogin: string | null = null;
  let envTokenError: string | null = null;
  let resolvedProjectId: string | null = null;
  let resolvedProjectConfig:
    | Awaited<ReturnType<typeof inspectManagedProjectSelection>>
    | null = null;
  const envToken = deps.getEnvGitHubToken();

  const currentNodeVersion = deps.processVersion;
  const currentNodeMajor = parseMajorNodeVersion(currentNodeVersion);
  if (
    currentNodeMajor !== null &&
    currentNodeMajor >= MINIMUM_NODE_MAJOR
  ) {
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
      passCheck("gh_installation", "gh CLI installation", "gh CLI is installed.")
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

  const ghAuth = ghInstalled ? deps.checkGhAuthenticated() : { authenticated: false };
  const ghScopes =
    ghInstalled && ghAuth.authenticated
      ? deps.checkGhScopes()
      : { valid: false, missing: [...REQUIRED_GH_SCOPES], scopes: [] };

  if (envToken) {
    try {
      auth = await deps.validateGitHubToken(envToken, "env");
    } catch (error) {
      envTokenError =
        error instanceof Error ? error.message : "Unknown token validation error.";
    }
  }

  if (!auth && ghInstalled && ghAuth.authenticated && ghScopes.valid) {
    try {
      const ghToken = deps.getGhToken({ allowEnv: false });
      auth = await deps.validateGitHubToken(ghToken, "gh");
    } catch (error) {
      tokenError =
        error instanceof Error ? error.message : "Unknown token retrieval error.";
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
      ghInstalled && ghAuth.authenticated ? ghScopes.missing : [...REQUIRED_GH_SCOPES];
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
        "Run 'gh-symphony project add' to register a project, or select one with 'gh-symphony project switch' / '--project-id'.",
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
    !resolvedProjectConfig.projectConfig.tracker.bindingId
  ) {
    checks.push(
      failCheck(
        "github_project_resolution",
        "GitHub project resolution",
        `Managed project "${resolvedProjectConfig.projectId}" is not bound to a GitHub Project.`,
        "Re-run 'gh-symphony project add' and select a valid GitHub Project binding, then run the doctor command again.",
        {
          reason: "missing_binding" satisfies ProjectResolutionReason,
          projectId: resolvedProjectConfig.projectId,
        }
      )
    );
  } else if (
    auth &&
    resolvedProjectConfig.kind === "resolved" &&
    resolvedProjectConfig.projectConfig.tracker.bindingId
  ) {
    try {
      const client = deps.createClient(auth.token);
      const detail = await deps.getProjectDetail(
        client,
        resolvedProjectConfig.projectConfig.tracker.bindingId
      );
      checks.push(
        passCheck(
          "github_project_resolution",
          "GitHub project resolution",
          `Resolved GitHub Project "${detail.title}".`,
          {
            bindingId: resolvedProjectConfig.projectConfig.tracker.bindingId,
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
          `Failed to resolve configured project binding '${resolvedProjectConfig.projectConfig.tracker.bindingId}'.`,
          "Re-run 'gh-symphony project add' and select a valid GitHub Project, then run the doctor command again.",
          {
            reason: "api_error" satisfies ProjectResolutionReason,
            bindingId: resolvedProjectConfig.projectConfig.tracker.bindingId,
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
    const binary = extractCommandBinary(workflow.command);
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

  return {
    ok: checks.every((check) => check.status === "pass"),
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

  const result = deps.spawnSync(deps.execPath, [cliEntry, "--config", options.configDir, ...args], {
    stdio: "inherit",
  });
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
  const pathValue = typeof check.details?.path === "string" ? check.details.path : null;
  const reason = typeof check.details?.reason === "string" ? check.details.reason : null;
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
    const errorMessage = error instanceof Error ? error.message : "unknown error";
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
              "Managed project selection",
              check.id,
              ["project", "switch"],
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
            "Managed project setup",
            check.id,
            ["project", "add"],
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
          typeof check.details?.reason === "string" ? check.details.reason : null;
        if (reason === "missing_binding" || reason === "api_error") {
          steps.push(
            runCliRemediation(
              "GitHub project binding setup",
              check.id,
              ["project", "add"],
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
            formatGhSymphonyCommand(["project", "add"], deps, options),
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
          typeof check.details?.reason === "string" ? check.details.reason : null;
        const title =
          reason === "missing"
            ? "Repository workflow initialization"
            : "Repository workflow regeneration";
        steps.push(
          runCliRemediation(title, check.id, ["init"], deps, options, interactive, check.details)
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
            check.remediation ?? "Install the configured runtime command manually.",
            typeof check.details?.binary === "string"
              ? String(check.details.binary)
              : undefined,
            check.details
          )
        );
        break;
      }
    }
  }

  return steps;
}

function renderTextReport(report: DoctorReport): string {
  const lines = [
    `gh-symphony doctor`,
    `Auth source: ${report.authSource ?? "unavailable"}`,
    ...(report.authLogin ? [`Authenticated GitHub user: ${report.authLogin}`] : []),
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
    lines.push(`${check.status === "pass" ? "PASS" : "FAIL"} ${check.title}`);
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

export async function runDoctorCommand(
  args: string[],
  options: GlobalOptions,
  dependencies: Partial<DoctorDependencies> = {}
): Promise<void> {
  try {
    const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
    const parsedArgs = parseDoctorArgs(args);
    if (parsedArgs.error) {
      throw new Error(
        `${parsedArgs.error}\nUsage: gh-symphony doctor [--project-id <project-id>] [--fix]`
      );
    }

    const initialReport = await runDoctorDiagnostics(options, args, deps);
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

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => runDoctorCommand(args, options);

export default handler;
