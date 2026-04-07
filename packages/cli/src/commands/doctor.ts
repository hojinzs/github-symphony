import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  readFile,
  stat,
} from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import {
  createClient,
  getProjectDetail,
  GitHubApiError,
} from "../github/client.js";
import {
  checkGhAuthenticated,
  checkGhInstalled,
  checkGhScopes,
  getGhToken,
  REQUIRED_GH_SCOPES,
} from "../github/gh-auth.js";
import type { GlobalOptions } from "../index.js";
import { resolveRuntimeRoot } from "../orchestrator-runtime.js";
import { inspectManagedProjectSelection } from "../project-selection.js";
import { parseWorkflowMarkdown } from "@gh-symphony/core";

type DoctorStatus = "pass" | "fail";

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

export type DoctorCheckResult = {
  id: DoctorCheckId;
  title: string;
  status: DoctorStatus;
  required: true;
  summary: string;
  remediation?: string;
  details?: Record<string, unknown>;
};

export type DoctorReport = {
  ok: boolean;
  checkedAt: string;
  configDir: string;
  projectId: string | null;
  checks: DoctorCheckResult[];
};

type ParsedDoctorArgs = {
  projectId?: string;
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
      summary: string;
      remediation: string;
      workflowPath: string;
      error?: string;
    };

export type DoctorDependencies = {
  checkGhInstalled: typeof checkGhInstalled;
  checkGhAuthenticated: typeof checkGhAuthenticated;
  checkGhScopes: typeof checkGhScopes;
  getGhToken: typeof getGhToken;
  inspectManagedProjectSelection: typeof inspectManagedProjectSelection;
  createClient: typeof createClient;
  getProjectDetail: typeof getProjectDetail;
  readFile: typeof readFile;
  access: typeof access;
  mkdir: typeof mkdir;
  stat: typeof stat;
  parseWorkflowMarkdown: typeof parseWorkflowMarkdown;
  execFileSync: typeof execFileSync;
  pathEnv: string | undefined;
  pathExtEnv: string | undefined;
  platform: NodeJS.Platform;
  processVersion: string;
};

const DEFAULT_DEPENDENCIES: DoctorDependencies = {
  checkGhInstalled,
  checkGhAuthenticated,
  checkGhScopes,
  getGhToken,
  inspectManagedProjectSelection,
  createClient,
  getProjectDetail,
  readFile,
  access,
  mkdir,
  stat,
  parseWorkflowMarkdown,
  execFileSync,
  pathEnv: process.env.PATH,
  pathExtEnv: process.env.PATHEXT,
  platform: process.platform,
  processVersion: process.version,
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
  const parsed: ParsedDoctorArgs = {};

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

async function checkWritablePath(
  targetPath: string,
  deps: Pick<DoctorDependencies, "access" | "mkdir" | "stat">
): Promise<boolean> {
  try {
    await deps.access(targetPath, constants.W_OK);
    const target = await deps.stat(targetPath);
    return target.isDirectory();
  } catch {
    try {
      await deps.mkdir(targetPath, { recursive: true });
      await deps.access(targetPath, constants.W_OK);
      const target = await deps.stat(targetPath);
      return target.isDirectory();
    } catch {
      return false;
    }
  }
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
  if (
    isAbsolute(binary) ||
    binary.includes("/") ||
    binary.includes("\\")
  ) {
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
    };
  } catch (error) {
    return {
      status: "fail",
      workflowPath,
      summary: "WORKFLOW.md could not be parsed.",
      remediation:
        "Fix the WORKFLOW.md front matter or re-run 'gh-symphony workflow init' to regenerate it.",
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
      `${parsedArgs.error}\nUsage: gh-symphony doctor [--project-id <project-id>]`
    );
  }

  const checks: DoctorCheckResult[] = [];
  let token: string | null = null;
  let tokenError: string | null = null;
  let resolvedProjectId: string | null = null;
  let resolvedProjectConfig:
    | Awaited<ReturnType<typeof inspectManagedProjectSelection>>
    | null = null;

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
  if (ghInstalled && ghAuth.authenticated) {
    checks.push(
      passCheck(
        "gh_authentication",
        "gh authentication",
        `gh auth status succeeded${ghAuth.login ? ` as ${ghAuth.login}` : ""}.`,
        ghAuth.login ? { login: ghAuth.login } : undefined
      )
    );
  } else {
    checks.push(
      failCheck(
        "gh_authentication",
        "gh authentication",
        "gh auth status failed or no GitHub login is configured.",
        `Run 'gh auth login --scopes ${REQUIRED_GH_SCOPES.join(",")}' and re-run the doctor command.`
      )
    );
  }

  const ghScopes =
    ghInstalled && ghAuth.authenticated
      ? deps.checkGhScopes()
      : { valid: false, missing: [...REQUIRED_GH_SCOPES], scopes: [] };
  if (ghInstalled && ghAuth.authenticated && ghScopes.valid) {
    checks.push(
      passCheck(
        "gh_scopes",
        "GitHub token scopes",
        `Required scopes are present: ${REQUIRED_GH_SCOPES.join(", ")}.`,
        { scopes: ghScopes.scopes }
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

  if (ghInstalled && ghAuth.authenticated) {
    try {
      token = deps.getGhToken();
    } catch (error) {
      tokenError =
        error instanceof Error ? error.message : "Unknown token retrieval error.";
      token = null;
    }
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
        resolvedProjectConfig.projectId
          ? { projectId: resolvedProjectConfig.projectId }
          : undefined
      )
    );
  }

  if (resolvedProjectConfig.kind === "resolved" && !token) {
    checks.push(
      failCheck(
        "github_project_resolution",
        "GitHub project resolution",
        tokenError
          ? "GitHub project resolution could not run because the GitHub token could not be retrieved."
          : "GitHub project resolution could not run because authentication failed.",
        tokenError
          ? "Check the local keychain or environment used by 'gh auth token', then re-run 'gh-symphony doctor'."
          : "Fix the gh authentication check first, then re-run 'gh-symphony doctor'.",
        tokenError ? { error: tokenError } : undefined
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
        { projectId: resolvedProjectConfig.projectId }
      )
    );
  } else if (
    token &&
    resolvedProjectConfig.kind === "resolved" &&
    resolvedProjectConfig.projectConfig.tracker.bindingId
  ) {
    try {
      const client = deps.createClient(token);
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
        "Fix the managed project selection check first, then re-run 'gh-symphony doctor'."
      )
    );
  }

  const configDirWritable = await checkWritablePath(options.configDir, deps);
  checks.push(
    configDirWritable
      ? passCheck(
          "config_directory",
          "Config directory",
          `Config directory is writable: ${options.configDir}.`,
          { path: options.configDir }
        )
      : failCheck(
          "config_directory",
          "Config directory",
          `Config directory is not writable: ${options.configDir}.`,
          `Create the directory and ensure your user can write to it: 'mkdir -p ${options.configDir}' and fix ownership/permissions as needed.`,
          { path: options.configDir }
        )
  );

  const runtimeRoot = resolveRuntimeRoot(options.configDir);
  const runtimeRootWritable = await checkWritablePath(runtimeRoot, deps);
  checks.push(
    runtimeRootWritable
      ? passCheck(
          "runtime_root",
          "Runtime root",
          `Runtime root is writable: ${runtimeRoot}.`,
          { path: runtimeRoot }
        )
      : failCheck(
          "runtime_root",
          "Runtime root",
          `Runtime root is not writable: ${runtimeRoot}.`,
          `Create the runtime root and ensure your user can write to it: 'mkdir -p ${runtimeRoot}'.`,
          { path: runtimeRoot }
        )
  );

  if (resolvedProjectConfig.kind === "resolved") {
    const workspaceDir = resolvedProjectConfig.projectConfig.workspaceDir;
    const workspaceWritable = await checkWritablePath(workspaceDir, deps);
    checks.push(
      workspaceWritable
        ? passCheck(
            "workspace_root",
            "Workspace root",
            `Workspace root is writable: ${workspaceDir}.`,
            { path: workspaceDir }
          )
        : failCheck(
            "workspace_root",
            "Workspace root",
            `Workspace root is not writable: ${workspaceDir}.`,
            "Update the managed project workspaceDir to a writable path or fix the filesystem permissions.",
            { path: workspaceDir }
          )
    );
  } else {
    checks.push(
      failCheck(
        "workspace_root",
        "Workspace root",
        "Workspace root could not be checked because no managed project was resolved.",
        "Fix the managed project selection check first, then re-run 'gh-symphony doctor'."
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
          "Install the configured runtime binary or update the workflow/context configuration to a command that exists on this machine.",
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
        "Fix the WORKFLOW.md check first so the configured runtime command can be validated."
      )
    );
  }

  return {
    ok: checks.every((check) => check.status === "pass"),
    checkedAt: new Date().toISOString(),
    configDir: options.configDir,
    projectId: resolvedProjectId,
    checks,
  };
}

function renderTextReport(report: DoctorReport): string {
  const lines = [`gh-symphony doctor`, ""];
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
    const report = await runDoctorDiagnostics(options, args, dependencies);
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
