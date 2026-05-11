import * as p from "@clack/prompts";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolve } from "node:path";
import type { GlobalOptions } from "../index.js";
import {
  WorkflowConfigStore,
  type IssueOrchestrationRecord,
  type OrchestratorProjectConfig,
  type OrchestratorRunRecord,
  type ProjectItemsCache,
  type ProjectStatusSnapshot,
  type RepositoryRef,
  type WorkflowLifecycleConfig,
} from "@gh-symphony/core";
import {
  explainIssueDispatch,
  findGithubProjectIssue,
  isActiveRunRecordStatus,
  parseIssueIdentifier,
  resolveTrackerAdapter,
  type DispatchExplainReport,
} from "@gh-symphony/orchestrator";
import { bold, green, red, stripAnsi, yellow } from "../ansi.js";
import {
  createClient,
  validateToken,
  checkRequiredScopes,
  discoverUserProjects,
  listUserProjects,
  getProjectDetail,
  GitHubScopeError,
  type GitHubClient,
  type ProjectSummary,
  type ProjectDetail,
  type LinkedRepository,
} from "../github/client.js";
import { getGhTokenWithSource, GhAuthError } from "../github/gh-auth.js";
import { getGhToken } from "../github/gh-auth.js";
import { resolveGitHubAuth } from "../github/gh-auth.js";
import {
  loadGlobalConfig,
  saveGlobalConfig,
  loadProjectConfig,
  projectConfigDir,
  daemonPidPath,
  httpStatusPath,
  type CliGlobalConfig,
  type CliProjectConfig,
} from "../config.js";
import {
  writeConfig,
  generateProjectId,
  abortIfCancelled,
  warnIfProjectDiscoveryPartial,
} from "./workflow-init.js";
import startCommand from "./start.js";
import statusCommand from "./status.js";
import stopCommand from "./stop.js";
import { resolveRuntimeRoot } from "../orchestrator-runtime.js";
import {
  handleMissingManagedProjectConfig,
  resolveManagedProjectConfig,
} from "../project-selection.js";

const execFile = promisify(execFileCallback);

type ProjectListRow = {
  id: string;
  name: string;
  status: "running" | "stopped";
  health: string;
  activeRuns: number | null;
  lastTick: string;
  uptime: string;
  endpoint: string | null;
  active: boolean;
};

type HttpBindingState = {
  host?: unknown;
  port?: unknown;
  endpoint?: unknown;
};

const KNOWN_REQUIRED_SCOPES = ["repo", "read:org", "project"] as const;

type ProjectAddFlags = {
  nonInteractive: boolean;
  project?: string;
  workspaceDir?: string;
  assignedOnly?: boolean;
};

export type ProjectRegistrationOptions = {
  assignedOnly: boolean;
  selectedRepos: LinkedRepository[];
  workspaceDir: string;
};

function formatProjectRepoSummary(
  selectedRepos: ProjectDetail["linkedRepositories"],
  totalLinked: number
): string {
  if (totalLinked === 0) {
    return "none linked yet (0 linked)";
  }

  if (selectedRepos.length === totalLinked) {
    return `${selectedRepos.map((repo) => `${repo.owner}/${repo.name}`).join(", ")}  (all ${selectedRepos.length} linked)`;
  }

  if (selectedRepos.length === 0) {
    return `none selected  (0 of ${totalLinked} linked)`;
  }

  return `${selectedRepos.map((repo) => `${repo.owner}/${repo.name}`).join(", ")}  (${selectedRepos.length} of ${totalLinked} linked)`;
}

function projectCreatedMessage(
  projectId: string,
  repositoryCount: number
): string {
  const lines = [
    `Project "${projectId}" created with ${repositoryCount} repositor${repositoryCount === 1 ? "y" : "ies"}.`,
    "Run 'gh-symphony start' to begin orchestration.",
  ];

  if (repositoryCount === 0) {
    lines.push(
      "Next step: run 'gh-symphony repo add <owner/name>' to register a repository.",
      "Or add a repo-linked issue to the GitHub Project and re-run setup later."
    );
  }

  return lines.join("\n");
}

function displayScopeError(
  error: GitHubScopeError,
  retryCommand: string
): void {
  const plural = error.requiredScopes.length === 1 ? "" : "s";
  p.log.error(
    `Token is missing required scope${plural}: ${error.requiredScopes.join(", ")}`
  );
  const currentSet = new Set(error.currentScopes.map((s) => s.toLowerCase()));
  const scopesToAdd = KNOWN_REQUIRED_SCOPES.filter((s) => !currentSet.has(s));
  const scopeArg =
    scopesToAdd.length > 0
      ? scopesToAdd.join(",")
      : error.requiredScopes.join(",");
  p.note(
    `gh auth refresh --scopes ${scopeArg}\n\nThen re-run: ${retryCommand}`,
    "Fix missing scope"
  );
}

function parseProjectAddFlags(args: string[]): ProjectAddFlags {
  const flags: ProjectAddFlags = { nonInteractive: false };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--non-interactive":
        flags.nonInteractive = true;
        break;
      case "--project":
        flags.project = next;
        i += 1;
        break;
      case "--workspace-dir":
        flags.workspaceDir = next;
        i += 1;
        break;
      case "--assigned-only":
        flags.assignedOnly = true;
        break;
    }
  }

  return flags;
}

type ProjectExplainFlags = {
  identifier?: string;
  projectId?: string;
  workflowPath?: string;
  error?: string;
};

function parseProjectExplainFlags(args: string[]): ProjectExplainFlags {
  const parsed: ProjectExplainFlags = {};

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
    if (arg === "--workflow" || arg === "--workflow-path") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        parsed.error = `Option '${arg}' argument missing`;
        return parsed;
      }
      parsed.workflowPath = value;
      i += 1;
      continue;
    }
    if (arg?.startsWith("-")) {
      parsed.error = `Unknown option '${arg}'`;
      return parsed;
    }
    if (parsed.identifier) {
      parsed.error = "Only one issue identifier can be explained at a time";
      return parsed;
    }
    parsed.identifier = arg;
  }

  if (!parsed.identifier) {
    parsed.error = "Issue identifier argument missing";
  } else if (!parseIssueIdentifier(parsed.identifier)) {
    parsed.error = "Issue identifier must use the form <owner>/<repo>#<number>";
  }

  return parsed;
}

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => {
  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case "add":
      await projectAdd(rest, options);
      return;
    case "list":
      await projectList(options);
      return;
    case "remove":
      await projectRemove(rest, options);
      return;
    case "start":
      await startCommand(rest, options);
      return;
    case "stop":
      await stopCommand(rest, options);
      return;
    case "switch":
      await projectSwitch(options);
      return;
    case "status":
      await statusCommand(rest, options);
      return;
    case "explain":
      await projectExplain(rest, options);
      return;
    default:
      process.stdout.write(
        "Usage: gh-symphony project <add|list|remove|start|stop|switch|status|explain>\n"
      );
  }
};

export default handler;

function relativeTimeFromNow(isoString: string, now = new Date()): string {
  const then = new Date(isoString);
  if (!Number.isFinite(then.getTime())) {
    return "-";
  }
  const diffMs = Math.max(0, now.getTime() - then.getTime());
  const diffS = Math.floor(diffMs / 1000);
  const diffM = Math.floor(diffS / 60);
  const diffH = Math.floor(diffM / 60);
  const diffD = Math.floor(diffH / 24);

  if (diffS < 60) return `${diffS}s ago`;
  if (diffM < 60) return `${diffM}m ago`;
  if (diffH < 24) return `${diffH}h ago`;
  return `${diffD}d ago`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;

  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

function parsePsElapsedTime(raw: string): number | null {
  const value = raw.trim();
  if (value.length === 0) {
    return null;
  }

  const [dayPart, timePart] = value.includes("-")
    ? value.split("-", 2)
    : [null, value];
  const timeSegments = timePart
    .split(":")
    .map((segment) => Number.parseInt(segment, 10));
  if (timeSegments.some((segment) => !Number.isFinite(segment))) {
    return null;
  }

  let seconds = 0;
  if (timeSegments.length === 3) {
    seconds += timeSegments[0]! * 3_600;
    seconds += timeSegments[1]! * 60;
    seconds += timeSegments[2]!;
  } else if (timeSegments.length === 2) {
    seconds += timeSegments[0]! * 60;
    seconds += timeSegments[1]!;
  } else {
    return null;
  }

  if (dayPart !== null) {
    const days = Number.parseInt(dayPart, 10);
    if (!Number.isFinite(days)) {
      return null;
    }
    seconds += days * 86_400;
  }

  return seconds;
}

async function readPid(
  configDir: string,
  projectId: string
): Promise<number | null> {
  try {
    const raw = await readFile(daemonPidPath(configDir, projectId), "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      return true;
    }
    return false;
  }
}

async function readPersistedSnapshot(
  configDir: string,
  projectId: string
): Promise<ProjectStatusSnapshot | null> {
  try {
    const runtimeRoot = resolveRuntimeRoot(configDir);
    const content = await readFile(
      join(runtimeRoot, "projects", projectId, "status.json"),
      "utf8"
    );
    return JSON.parse(content) as ProjectStatusSnapshot;
  } catch {
    return null;
  }
}

async function fetchProjectSnapshot(
  configDir: string,
  projectId: string
): Promise<ProjectStatusSnapshot | null> {
  return readPersistedSnapshot(configDir, projectId);
}

async function projectExplain(
  args: string[],
  options: GlobalOptions
): Promise<void> {
  const parsed = parseProjectExplainFlags(args);
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n`);
    process.stderr.write(
      "Usage: gh-symphony project explain <owner/repo#number> [--project-id <project-id>] [--workflow <path>]\n"
    );
    process.exitCode = 2;
    return;
  }

  const projectConfig = await resolveManagedProjectConfig({
    configDir: options.configDir,
    requestedProjectId: parsed.projectId,
  });
  if (!projectConfig) {
    handleMissingManagedProjectConfig();
    return;
  }

  const identifier = parsed.identifier!;
  const parsedIdentifier = parseIssueIdentifier(identifier)!;
  const fallbackRepository: RepositoryRef = {
    owner: parsedIdentifier.owner,
    name: parsedIdentifier.name,
    cloneUrl: `https://github.com/${parsedIdentifier.owner}/${parsedIdentifier.name}.git`,
  };
  const workflowRepository = projectConfig.repository ?? fallbackRepository;
  let token: string;
  try {
    token = getGhToken();
  } catch (error) {
    if (error instanceof GhAuthError) {
      process.stderr.write(
        `Error: GitHub authentication is required for project explain. ${error.message}\n`
      );
      process.stderr.write(
        "Run 'gh auth login --scopes repo,read:org,project' or set GITHUB_GRAPHQL_TOKEN, then re-run this command.\n"
      );
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  const trackerAdapter = resolveTrackerAdapter(projectConfig.tracker);
  const orchestratorProject = {
    ...projectConfig,
    repository: workflowRepository,
  } as OrchestratorProjectConfig;
  const trackerDependencies = {
    token,
    projectItemsCache: createProjectItemsCache(),
  };
  const runtimeRoot = join(
    resolveRuntimeRoot(options.configDir),
    "projects",
    projectConfig.projectId
  );
  const issuesPromise = trackerAdapter.listIssues(
    orchestratorProject,
    trackerDependencies
  );
  const issuePromise =
    projectConfig.tracker.adapter === "github-project"
      ? findGithubProjectIssue(
          orchestratorProject,
          identifier,
          trackerDependencies
        )
      : issuesPromise.then(
          (issues) =>
            issues.find(
              (candidate) =>
                candidate.identifier.trim().toLowerCase() ===
                identifier.trim().toLowerCase()
            ) ?? null
        );
  const [issues, issue, issueRecords, runs, snapshot] = await Promise.all([
    issuesPromise,
    issuePromise,
    readJsonFile<IssueOrchestrationRecord[]>(join(runtimeRoot, "issues.json")),
    readRuns(runtimeRoot, projectConfig.projectId),
    readPersistedSnapshot(options.configDir, projectConfig.projectId),
  ]);
  let workflow: ExplainWorkflowSettings;
  try {
    workflow = await loadExplainWorkflow({
      explicitWorkflowPath: parsed.workflowPath,
      repository: workflowRepository,
      runs,
    });
  } catch (error) {
    if (error instanceof ProjectExplainWorkflowError) {
      process.stderr.write(`Error: ${error.message}\n`);
      process.stderr.write(
        "Hint: pass --workflow <path-to-WORKFLOW.md> or run 'gh-symphony workflow preview --file <path>' to verify the workflow file.\n"
      );
      process.exitCode = 2;
      return;
    }
    throw error;
  }
  const activeRunCount = runs.filter((run) =>
    isActiveRunRecordStatus(run.status)
  ).length;
  const report = explainIssueDispatch({
    identifier,
    issue,
    projectRepository: projectConfig.repository ?? null,
    allIssues: issues,
    lifecycle: workflow.lifecycle,
    issueRecords: issueRecords ?? [],
    runs,
    activeRunCount,
    maxConcurrentAgents: workflow.maxConcurrentAgents,
    maxConcurrentAgentsByState: workflow.maxConcurrentAgentsByState,
  });
  const enrichedReport = {
    ...report,
    project: {
      id: projectConfig.projectId,
      slug: projectConfig.slug,
      tracker: projectConfig.tracker,
      lastTickAt: snapshot?.lastTickAt ?? null,
      health: snapshot?.health ?? null,
    },
  };

  if (options.json) {
    process.stdout.write(JSON.stringify(enrichedReport, null, 2) + "\n");
    return;
  }

  process.stdout.write(renderProjectExplainReport(report, options.noColor));
}

type ExplainWorkflowSettings = {
  lifecycle: WorkflowLifecycleConfig;
  maxConcurrentAgents: number;
  maxConcurrentAgentsByState: Record<string, number>;
};

class ProjectExplainWorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProjectExplainWorkflowError";
  }
}

async function loadExplainWorkflow(input: {
  explicitWorkflowPath?: string;
  repository: RepositoryRef;
  runs: readonly OrchestratorRunRecord[];
}): Promise<ExplainWorkflowSettings> {
  const workflowPaths = resolveExplainWorkflowCandidates(input);
  if (workflowPaths.length === 0) {
    throw new ProjectExplainWorkflowError(
      "No WORKFLOW.md path could be resolved from --workflow, the configured repository path, or previous run records."
    );
  }

  const failures: string[] = [];
  for (const workflowPath of workflowPaths) {
    try {
      const resolution = await new WorkflowConfigStore().load(workflowPath);
      return {
        lifecycle: resolution.lifecycle,
        maxConcurrentAgents: resolution.workflow.agent.maxConcurrentAgents,
        maxConcurrentAgentsByState:
          resolution.workflow.agent.maxConcurrentAgentsByState,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${workflowPath}: ${message}`);
    }
  }

  throw new ProjectExplainWorkflowError(
    `Unable to load WORKFLOW.md for project explain. Checked: ${failures.join("; ")}`
  );
}

function resolveExplainWorkflowCandidates(input: {
  explicitWorkflowPath?: string;
  repository: RepositoryRef;
  runs: readonly OrchestratorRunRecord[];
}): string[] {
  const paths: string[] = [];
  if (input.explicitWorkflowPath) {
    paths.push(resolve(input.explicitWorkflowPath));
  }
  if (input.repository.path) {
    paths.push(join(resolve(input.repository.path), "WORKFLOW.md"));
  }

  const newestRuns = [...input.runs].sort(
    (left, right) =>
      (Date.parse(right.updatedAt) || 0) - (Date.parse(left.updatedAt) || 0)
  );
  for (const run of newestRuns) {
    if (run.workflowPath) {
      paths.push(resolve(run.workflowPath));
    }
    if (run.workingDirectory) {
      paths.push(join(resolve(run.workingDirectory), "WORKFLOW.md"));
    }
  }

  return [...new Set(paths)];
}

function createProjectItemsCache(): ProjectItemsCache {
  const entries = new Map<string, ReturnType<ProjectItemsCache["getOrLoad"]>>();
  return {
    getOrLoad(key, load) {
      const cached = entries.get(key);
      if (cached) {
        return cached;
      }
      const pending = load().catch((error) => {
        entries.delete(key);
        throw error;
      });
      entries.set(key, pending);
      return pending;
    },
  };
}

async function readRuns(
  runtimeRoot: string,
  projectId: string
): Promise<OrchestratorRunRecord[]> {
  let runIds: string[];
  try {
    runIds = await readdir(join(runtimeRoot, "runs"));
  } catch {
    return [];
  }

  const runs = await Promise.all(
    runIds.map((runId) =>
      readJsonFile<OrchestratorRunRecord>(
        join(runtimeRoot, "runs", runId, "run.json")
      )
    )
  );
  return runs.filter(
    (run): run is OrchestratorRunRecord =>
      run !== null && run.projectId === projectId
  );
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function renderProjectExplainReport(
  report: DispatchExplainReport,
  noColor: boolean
): string {
  const apply = noColor
    ? (value: string) => stripAnsi(value)
    : (value: string) => value;
  const lines = [
    apply(bold(`Issue dispatch explanation: ${report.issue.identifier}`)),
    report.summary,
    "",
    `State: ${report.issue.state ?? "unknown"}`,
    `Repository: ${report.issue.repository}`,
    "",
    "Checks:",
  ];

  for (const check of report.checks) {
    const marker =
      check.status === "pass"
        ? green("✓")
        : check.status === "warn"
          ? yellow("!")
          : red("✗");
    lines.push(`  ${apply(marker)} ${check.message}`);
    if (check.hint) {
      lines.push(`    Hint: ${check.hint}`);
    }
  }

  lines.push("");
  lines.push("Related commands:");
  lines.push("  gh-symphony workflow preview");
  lines.push("  gh-symphony doctor");
  lines.push("  gh-symphony project status");
  lines.push("  gh-symphony logs --issue " + report.issue.identifier);
  return lines.join("\n") + "\n";
}

async function readHttpEndpoint(
  configDir: string,
  projectId: string
): Promise<string | null> {
  try {
    const content = await readFile(
      httpStatusPath(configDir, projectId),
      "utf8"
    );
    const state = JSON.parse(content) as HttpBindingState;
    return typeof state.endpoint === "string" && state.endpoint.length > 0
      ? state.endpoint
      : null;
  } catch {
    return null;
  }
}

async function readProcessUptime(pid: number): Promise<string> {
  if (process.platform === "win32") {
    return "-";
  }

  try {
    const { stdout } = await execFile("ps", [
      "-o",
      "etime=",
      "-p",
      String(pid),
    ]);
    const seconds = parsePsElapsedTime(stdout);
    return seconds === null ? "-" : formatDuration(seconds);
  } catch {
    return "-";
  }
}

function defaultProjectName(
  config: CliProjectConfig | null,
  projectId: string
): string {
  return config?.displayName ?? config?.slug ?? projectId;
}

function isCombiningCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
  );
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1f64f) ||
      (codePoint >= 0x1f900 && codePoint <= 0x1f9ff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

function stringDisplayWidth(value: string): number {
  const visible = stripAnsi(value);
  let width = 0;
  for (const char of visible) {
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    if (
      codePoint === 0 ||
      codePoint < 0x20 ||
      (codePoint >= 0x7f && codePoint < 0xa0) ||
      isCombiningCodePoint(codePoint)
    ) {
      continue;
    }
    width += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return width;
}

async function collectProjectListRows(
  configDir: string,
  global: CliGlobalConfig
): Promise<ProjectListRow[]> {
  return Promise.all(
    global.projects.map(async (projectId) => {
      const config = await loadProjectConfig(configDir, projectId);
      const pid = await readPid(configDir, projectId);
      const running = pid !== null && isProcessRunning(pid);
      const snapshot = running
        ? await fetchProjectSnapshot(configDir, projectId)
        : null;

      return {
        id: projectId,
        name: defaultProjectName(config, projectId),
        status: running ? "running" : "stopped",
        health: snapshot?.health ?? "-",
        activeRuns: snapshot?.summary.activeRuns ?? null,
        lastTick: snapshot?.lastTickAt
          ? relativeTimeFromNow(snapshot.lastTickAt)
          : "-",
        uptime: pid !== null && running ? await readProcessUptime(pid) : "-",
        endpoint: running ? await readHttpEndpoint(configDir, projectId) : null,
        active: global.activeProject === projectId,
      } satisfies ProjectListRow;
    })
  );
}

function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, index) =>
    Math.max(
      stringDisplayWidth(header),
      ...rows.map((row) => stringDisplayWidth(row[index] ?? ""))
    )
  );

  const formatRow = (
    left: string,
    sep: string,
    right: string,
    values: string[]
  ) =>
    left +
    values
      .map((value, index) => {
        const width = widths[index]!;
        const displayWidth = stringDisplayWidth(value);
        return ` ${value}${" ".repeat(width - displayWidth)} `;
      })
      .join(sep) +
    right;

  const border = (left: string, middle: string, right: string) =>
    left + widths.map((width) => "─".repeat(width + 2)).join(middle) + right;

  return [
    border("┌", "┬", "┐"),
    formatRow("│", "│", "│", headers),
    border("├", "┼", "┤"),
    ...rows.map((row) => formatRow("│", "│", "│", row)),
    border("└", "┴", "┘"),
  ].join("\n");
}

async function projectAdd(
  args: string[],
  options: GlobalOptions
): Promise<void> {
  const flags = parseProjectAddFlags(args);

  if (flags.nonInteractive) {
    await projectAddNonInteractive(flags, options);
    return;
  }

  await projectAddInteractive(flags, options);
}

async function projectAddNonInteractive(
  flags: ProjectAddFlags,
  options: GlobalOptions
): Promise<void> {
  let token: string;
  try {
    token = getGhTokenWithSource().token;
  } catch {
    process.stderr.write(
      "Error: GitHub token not found. Run 'gh auth login --scopes repo,read:org,project' or set GITHUB_GRAPHQL_TOKEN.\n"
    );
    process.exitCode = 1;
    return;
  }

  const client = createClient(token);

  let viewer;
  try {
    viewer = await validateToken(client);
  } catch {
    process.stderr.write("Error: Invalid GitHub token.\n");
    process.exitCode = 1;
    return;
  }

  const scopeCheck = checkRequiredScopes(viewer.scopes);
  if (!scopeCheck.valid) {
    process.stderr.write(
      `Error: Missing required PAT scopes: ${scopeCheck.missing.join(", ")}\n`
    );
    process.exitCode = 1;
    return;
  }

  const projects = await listUserProjects(client);
  let project: ProjectDetail | undefined;

  if (flags.project) {
    const match = projects.find(
      (entry) => entry.id === flags.project || entry.url === flags.project
    );
    if (!match) {
      process.stderr.write(`Error: Project not found: ${flags.project}\n`);
      process.exitCode = 1;
      return;
    }
    project = await getProjectDetail(client, match.id);
  } else if (projects.length === 1) {
    project = await getProjectDetail(client, projects[0]!.id);
  } else {
    process.stderr.write(
      "Error: --project is required when multiple projects exist.\n"
    );
    process.exitCode = 1;
    return;
  }

  const projectId = generateProjectId(project.title, project.id);
  const workspaceDir =
    flags.workspaceDir ?? join(options.configDir, "workspaces");

  await writeConfig(options.configDir, {
    projectId,
    project,
    repos: project.linkedRepositories,
    workspaceDir,
    assignedOnly: flags.assignedOnly,
  });

  if (options.json) {
    process.stdout.write(
      JSON.stringify({ projectId, status: "created" }) + "\n"
    );
  } else {
    process.stdout.write(
      projectCreatedMessage(projectId, project.linkedRepositories.length) + "\n"
    );
  }
}

async function projectAddInteractive(
  flags: ProjectAddFlags,
  options: GlobalOptions
): Promise<void> {
  p.intro("gh-symphony - Project Setup");
  const defaultWorkspaceDir = join(options.configDir, "workspaces");

  const existingConfig = await loadGlobalConfig(options.configDir);
  if (existingConfig) {
    const action = await abortIfCancelled(
      p.select({
        message: "Existing configuration detected. What would you like to do?",
        options: [
          { value: "add", label: "Add a new project" },
          { value: "overwrite", label: "Start fresh (overwrite)" },
        ],
      })
    );
    if (action === "overwrite") {
      // Continue with fresh setup and overwrite the active config.
    }
  }

  const s1 = p.spinner();
  s1.start("Checking GitHub authentication...");

  let login: string;
  let client: GitHubClient;

  try {
    const auth = await resolveGitHubAuth();
    const sourceLabel =
      auth.source === "env" ? "GITHUB_GRAPHQL_TOKEN" : "gh CLI";
    login = auth.login;
    client = createClient(auth.token);
    s1.stop(`Authenticated via ${sourceLabel} as ${login}`);
  } catch (error) {
    s1.stop("Authentication failed.");
    if (error instanceof GhAuthError) {
      p.log.error(error.message);
    } else {
      p.log.error(error instanceof Error ? error.message : "Unknown error");
    }
    process.exitCode = 1;
    return;
  }

  const s2 = p.spinner();
  s2.start("Loading GitHub Project boards...");
  let projects: ProjectSummary[];
  try {
    const discovery = await discoverUserProjects(client);
    projects = discovery.projects;
    s2.stop(
      `Found ${projects.length} project${projects.length === 1 ? "" : "s"}`
    );
    warnIfProjectDiscoveryPartial(discovery);
  } catch (error) {
    s2.stop("Failed to load projects.");
    if (error instanceof GitHubScopeError) {
      displayScopeError(error, "gh-symphony project add");
    } else {
      p.log.error(error instanceof Error ? error.message : "Unknown error");
    }
    process.exitCode = 1;
    return;
  }

  if (projects.length === 0) {
    p.log.error(
      "No GitHub Projects found. Create a project at https://github.com/orgs/YOUR_ORG/projects and re-run."
    );
    process.exitCode = 1;
    return;
  }

  const selectedProjectId = await abortIfCancelled(
    p.select({
      message: "Step 1/2 - Select a GitHub Project board:",
      options: projects.map((project) => ({
        value: project.id,
        label: `${project.owner.login}/${project.title}`,
        hint: `${project.openItemCount} items`,
      })),
      maxItems: 15,
    })
  );

  const s2d = p.spinner();
  s2d.start("Loading project details...");
  let projectDetail: ProjectDetail;
  try {
    projectDetail = await getProjectDetail(client, selectedProjectId);
    s2d.stop(`Loaded: ${projectDetail.title}`);
  } catch (error) {
    s2d.stop("Failed to load project details.");
    p.log.error(error instanceof Error ? error.message : "Unknown error");
    process.exitCode = 1;
    return;
  }

  if (projectDetail.linkedRepositories.length === 0) {
    p.log.warn(
      "No linked repositories found in this project. Add issues from repositories to the project, or run 'gh-symphony repo add owner/name' to validate and save a repository before your first orchestration run."
    );
  }

  const {
    assignedOnly: promptAssignedOnly,
    selectedRepos,
    workspaceDir,
  } = await promptProjectRegistrationOptions({
    projectDetail,
    defaultWorkspaceDir,
    assignedOnlyMessage:
      "Step 2/2 - Only process issues assigned to the authenticated GitHub user?",
    assignedOnlyInitialValue: flags.assignedOnly,
  });
  const assignedOnly = flags.assignedOnly || promptAssignedOnly;

  const repoSummary = formatProjectRepoSummary(
    selectedRepos,
    projectDetail.linkedRepositories.length
  );

  p.note(
    renderProjectRegistrationSummary({
      login,
      projectTitle: projectDetail.title,
      repoSummary,
      assignedOnly,
      workspaceDir,
    }),
    "Configuration Summary"
  );

  const confirmed = await abortIfCancelled(
    p.confirm({ message: "Apply this configuration?" })
  );

  if (!confirmed) {
    p.cancel("Setup cancelled.");
    process.exitCode = 130;
    return;
  }

  const projectId = generateProjectId(projectDetail.title, projectDetail.id);

  const s6 = p.spinner();
  s6.start("Writing configuration...");

  try {
    await writeConfig(options.configDir, {
      projectId,
      project: projectDetail,
      repos: selectedRepos,
      workspaceDir,
      assignedOnly,
    });
    s6.stop("Configuration saved.");
  } catch (error) {
    s6.stop("Failed to write configuration.");
    p.log.error(error instanceof Error ? error.message : "Unknown error");
    process.exitCode = 1;
    return;
  }

  p.outro(projectCreatedMessage(projectId, selectedRepos.length));
}

export async function promptProjectRegistrationOptions(input: {
  projectDetail: ProjectDetail;
  defaultWorkspaceDir: string;
  assignedOnlyMessage?: string;
  assignedOnlyInitialValue?: boolean;
}): Promise<ProjectRegistrationOptions> {
  const assignedOnly = await abortIfCancelled(
    p.confirm({
      message:
        input.assignedOnlyMessage ??
        "Only process issues assigned to the authenticated GitHub user?",
      initialValue: input.assignedOnlyInitialValue ?? false,
    })
  );

  const customizeAdvancedOptions = await abortIfCancelled(
    p.confirm({
      message: "Customize advanced options? (default: No)",
      initialValue: false,
    })
  );

  let selectedRepos = input.projectDetail.linkedRepositories;
  let workspaceDir = input.defaultWorkspaceDir;

  if (customizeAdvancedOptions) {
    if (input.projectDetail.linkedRepositories.length > 0) {
      const filterRepositories = await abortIfCancelled(
        p.confirm({
          message: "Filter specific repositories? (default: No)",
          initialValue: false,
        })
      );

      if (filterRepositories) {
        selectedRepos = await abortIfCancelled(
          p.multiselect({
            message: "Select repositories to orchestrate:",
            options: input.projectDetail.linkedRepositories.map((repo) => ({
              value: repo,
              label: `${repo.owner}/${repo.name}`,
            })),
            required: true,
          })
        );
      }
    }

    workspaceDir = await abortIfCancelled(
      p.text({
        message: "Workspace root directory:",
        placeholder: input.defaultWorkspaceDir,
        defaultValue: input.defaultWorkspaceDir,
        validate(value: string) {
          return value.trim().length > 0
            ? undefined
            : "Workspace directory is required.";
        },
      })
    );
  }

  return {
    assignedOnly,
    selectedRepos,
    workspaceDir,
  };
}

export function renderProjectRegistrationSummary(input: {
  login: string;
  projectTitle: string;
  repoSummary: string;
  assignedOnly: boolean;
  workspaceDir: string;
}): string {
  return [
    `User:       ${input.login}`,
    `Project:    ${input.projectTitle}`,
    `Repos:      ${input.repoSummary}`,
    `Assigned:   ${input.assignedOnly ? `Only issues assigned to ${input.login}` : "All project issues"}`,
    `Workspace:  ${input.workspaceDir}`,
  ].join("\n");
}

async function projectList(options: GlobalOptions): Promise<void> {
  const global = await loadGlobalConfig(options.configDir);
  if (!global?.projects?.length) {
    process.stdout.write("No projects configured.\n");
    return;
  }

  const rows = await collectProjectListRows(options.configDir, global);

  if (options.json) {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return;
  }

  const showEndpointColumn = rows.some((row) => row.endpoint !== null);
  const headers = [
    "ID",
    "Name",
    "Status",
    "Health",
    "Active Runs",
    "Last Tick",
    "Uptime",
    ...(showEndpointColumn ? ["Endpoint"] : []),
  ];
  const table = renderTable(
    headers,
    rows.map((row) => [
      row.id,
      row.name,
      row.status,
      row.health,
      row.activeRuns === null ? "-" : String(row.activeRuns),
      row.lastTick,
      row.uptime,
      ...(showEndpointColumn ? [row.endpoint ?? "-"] : []),
    ])
  );
  process.stdout.write(`${table}\n`);
}

async function projectRemove(
  args: string[],
  options: GlobalOptions
): Promise<void> {
  const projectId = args[0];
  if (!projectId) {
    process.stderr.write("Usage: gh-symphony project remove <project-id>\n");
    process.exitCode = 1;
    return;
  }

  const global = await loadGlobalConfig(options.configDir);
  if (!global) {
    process.stderr.write("No configuration found.\n");
    process.exitCode = 1;
    return;
  }

  const updatedProjects = global.projects.filter(
    (entry) => entry !== projectId
  );
  if (updatedProjects.length === global.projects.length) {
    process.stderr.write(`Project "${projectId}" not found.\n`);
    process.exitCode = 1;
    return;
  }

  const updatedConfig: CliGlobalConfig = {
    ...global,
    projects: updatedProjects,
    activeProject:
      global.activeProject === projectId ? null : global.activeProject,
  };
  await saveGlobalConfig(options.configDir, updatedConfig);

  const { rm } = await import("node:fs/promises");
  try {
    await rm(projectConfigDir(options.configDir, projectId), {
      recursive: true,
      force: true,
    });
  } catch {
    // Directory may not exist.
  }

  process.stdout.write(`Project "${projectId}" removed.\n`);
}

async function projectSwitch(options: GlobalOptions): Promise<void> {
  const global = await loadGlobalConfig(options.configDir);
  if (!global || global.projects.length === 0) {
    process.stderr.write(
      "No projects configured. Run 'gh-symphony workflow init'.\n"
    );
    process.exitCode = 1;
    return;
  }

  if (global.projects.length === 1) {
    process.stdout.write(`Only one project exists: ${global.projects[0]}\n`);
    return;
  }

  const selected = await p.select({
    message: "Select project to activate:",
    options: global.projects.map((projectId) => ({
      value: projectId,
      label: projectId,
      hint: projectId === global.activeProject ? "current" : undefined,
    })),
  });

  if (p.isCancel(selected)) {
    p.cancel("Cancelled.");
    return;
  }

  global.activeProject = selected;
  await saveGlobalConfig(options.configDir, global);
  process.stdout.write(`Switched to project: ${selected}\n`);
}
