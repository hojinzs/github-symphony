import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
import { loadActiveProjectConfig } from "../config.js";
import { getGhToken, GhAuthError } from "../github/gh-auth.js";

type RepoExplainFlags = {
  identifier?: string;
  workflowPath?: string;
  error?: string;
};

function parseRepoExplainFlags(args: string[]): RepoExplainFlags {
  const parsed: RepoExplainFlags = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
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
  const parsed = parseRepoExplainFlags(args);
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n`);
    process.stderr.write(
      "Usage: gh-symphony repo explain <owner/repo#number> [--workflow <path>]\n"
    );
    process.exitCode = 2;
    return;
  }

  const projectConfig = await loadActiveProjectConfig(options.configDir);
  if (!projectConfig) {
    process.stderr.write(
      "No repository runtime configured. Run 'gh-symphony repo init' in the target repository.\n"
    );
    process.exitCode = 1;
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
        `Error: GitHub authentication is required for repo explain. ${error.message}\n`
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
  const runtimeRoot = options.configDir;
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
    readJsonFile<ProjectStatusSnapshot>(join(runtimeRoot, "status.json")),
  ]);

  let workflow: ExplainWorkflowSettings;
  try {
    workflow = await loadExplainWorkflow({
      explicitWorkflowPath: parsed.workflowPath,
      repository: workflowRepository,
      runs,
    });
  } catch (error) {
    if (error instanceof RepoExplainWorkflowError) {
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

  process.stdout.write(renderRepoExplainReport(report, options.noColor));
};

export default handler;

type ExplainWorkflowSettings = {
  lifecycle: WorkflowLifecycleConfig;
  maxConcurrentAgents: number;
  maxConcurrentAgentsByState: Record<string, number>;
};

class RepoExplainWorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoExplainWorkflowError";
  }
}

async function loadExplainWorkflow(input: {
  explicitWorkflowPath?: string;
  repository: RepositoryRef;
  runs: readonly OrchestratorRunRecord[];
}): Promise<ExplainWorkflowSettings> {
  const workflowPaths = resolveExplainWorkflowCandidates(input);
  if (workflowPaths.length === 0) {
    throw new RepoExplainWorkflowError(
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

  throw new RepoExplainWorkflowError(
    `Unable to load WORKFLOW.md for repo explain. Checked: ${failures.join("; ")}`
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
      run !== null && (!run.projectId || run.projectId === projectId)
  );
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function renderRepoExplainReport(
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
  lines.push("  gh-symphony repo status");
  lines.push("  gh-symphony repo logs --issue " + report.issue.identifier);
  return lines.join("\n") + "\n";
}
