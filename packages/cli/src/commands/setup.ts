import * as p from "@clack/prompts";
import { resolve } from "node:path";
import type { GlobalOptions } from "../index.js";
import {
  createClient,
  validateToken,
  checkRequiredScopes,
  listUserProjects,
  getProjectDetail,
  GitHubScopeError,
  type GitHubClient,
  type ProjectDetail,
  type ProjectSummary,
} from "../github/client.js";
import {
  ensureGhAuth,
  getGhToken,
  GhAuthError,
  REQUIRED_GH_SCOPES,
} from "../github/gh-auth.js";
import {
  abortIfCancelled,
  buildAutomaticStateMappings,
  planWorkflowArtifacts,
  resolvePriorityField,
  promptPriorityConfig,
  collectPriorityLabelNames,
  renderDryRunPreview,
  resolveStatusField,
  writeEcosystem,
  writeWorkflowPlan,
  promptStateMappings,
  promptBlockerCheck,
} from "./workflow-init.js";
import {
  toWorkflowLifecycleConfig,
  validateStateMapping,
} from "../mapping/smart-defaults.js";
import { initRepoRuntime } from "../repo-runtime.js";

type SetupFlags = {
  nonInteractive: boolean;
  output?: string;
  skipSkills: boolean;
  skipContext: boolean;
};

function parseSetupFlags(args: string[]): SetupFlags {
  const flags: SetupFlags = {
    nonInteractive: false,
    skipSkills: false,
    skipContext: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case "--non-interactive":
        flags.nonInteractive = true;
        break;
      case "--output":
        flags.output = next;
        i += 1;
        break;
      case "--skip-skills":
        flags.skipSkills = true;
        break;
      case "--skip-context":
        flags.skipContext = true;
        break;
      default:
        if (arg?.startsWith("-")) {
          throw new Error(
            `Unknown option '${arg}'. Removed project/workspace flags are no longer supported; run 'gh-symphony setup' from inside the target repository. Supported flags: --non-interactive, --output, --skip-skills, --skip-context.`
          );
        }
    }
  }

  return flags;
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
  const scopesToAdd = REQUIRED_GH_SCOPES.filter((s) => !currentSet.has(s));
  const scopeArg =
    scopesToAdd.length > 0
      ? scopesToAdd.join(",")
      : error.requiredScopes.join(",");
  p.note(
    `gh auth refresh --scopes ${scopeArg}\n\nThen re-run: ${retryCommand}`,
    "Fix missing scope"
  );
}

async function resolveProjectDetail(
  client: GitHubClient
): Promise<ProjectDetail> {
  const projects = await listUserProjects(client);

  if (projects.length === 0) {
    throw new Error(
      "No GitHub Projects found. Create a project first and re-run setup."
    );
  }

  if (projects.length === 1) {
    return getProjectDetail(client, projects[0]!.id);
  }

  throw new Error(
    "Error: non-interactive setup requires exactly one GitHub Project. Use 'gh-symphony workflow init' for project selection, then run 'gh-symphony repo init'."
  );
}

async function selectProjectSummary(
  client: GitHubClient
): Promise<ProjectSummary> {
  const projects = await listUserProjects(client);
  if (projects.length === 0) {
    throw new Error(
      "No GitHub Projects found. Create a project at https://github.com/orgs/YOUR_ORG/projects and re-run."
    );
  }

  const selectedProjectId = await abortIfCancelled(
    p.select({
      message: "Step 1/4 — Select a GitHub Project board:",
      options: projects.map((project) => ({
        value: project.id,
        label: `${project.owner.login}/${project.title}`,
        hint: `${project.openItemCount} items`,
      })),
      maxItems: 15,
    })
  );

  return projects.find((project) => project.id === selectedProjectId)!;
}

function printNonInteractiveSummary(input: {
  githubProjectTitle: string;
  githubProjectId: string;
  workflowPath: string;
  runtimeDir: string;
  repository: string;
}): void {
  process.stdout.write(
    [
      `GitHub Project   ${input.githubProjectTitle}  (${input.githubProjectId})`,
      `Repository       ${input.repository}`,
      `WORKFLOW.md      ${input.workflowPath}`,
      `Runtime          ${input.runtimeDir}`,
      "Ready. Run 'gh-symphony repo start' to begin orchestration.",
    ]
      .map((line) => `  ${line}`)
      .join("\n") + "\n"
  );
}

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => {
  let flags: SetupFlags;
  try {
    flags = parseSetupFlags(args);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Invalid setup arguments"}\n`
    );
    process.exitCode = 2;
    return;
  }

  if (flags.nonInteractive) {
    await runNonInteractive(flags, options);
    return;
  }

  await runInteractive(flags, options);
};

export default handler;

async function runNonInteractive(
  flags: SetupFlags,
  options: GlobalOptions
): Promise<void> {
  let token: string;
  try {
    token = getGhToken();
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

  let projectDetail: ProjectDetail;
  try {
    projectDetail = await resolveProjectDetail(client);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Unknown error"}\n`
    );
    process.exitCode = 1;
    return;
  }

  const statusField = resolveStatusField(projectDetail);
  if (!statusField) {
    process.stderr.write("Error: No status field found on the project.\n");
    process.exitCode = 1;
    return;
  }

  const mappings = buildAutomaticStateMappings(statusField);
  const { field: priorityField, ambiguous: ambiguousPriorityFields } =
    resolvePriorityField(projectDetail, statusField);
  if (ambiguousPriorityFields.length > 0) {
    process.stderr.write(
      `Warning: Multiple priority-like single-select fields found (${ambiguousPriorityFields.map((field) => `"${field.name}"`).join(", ")}). Writing disabled priority scaffold in non-interactive mode.\n`
    );
  }
  const priority = priorityField
    ? {
        source: "project-field" as const,
        field: priorityField.name,
        values: Object.fromEntries(
          priorityField.options.map((option, index) => [option.name, index])
        ),
      }
    : { source: "disabled" as const };
  const workflowValidation = validateStateMapping(mappings);
  if (!workflowValidation.valid) {
    process.stderr.write(
      `Error: Cannot auto-map columns. ${workflowValidation.errors.join("; ")}\nRun setup without --non-interactive for manual mapping.\n`
    );
    process.exitCode = 1;
    return;
  }

  const workflowPath = resolve(flags.output ?? "WORKFLOW.md");
  const { workflowPlan } = await planWorkflowArtifacts({
    cwd: process.cwd(),
    outputPath: workflowPath,
    projectDetail,
    statusField,
    priorityField,
    priority,
    includePriorityTemplates: !priorityField,
    mappings,
    runtime: "codex",
    skipSkills: flags.skipSkills,
    skipContext: flags.skipContext,
  });

  await writeWorkflowPlan(workflowPlan);
  await writeEcosystem({
    cwd: process.cwd(),
    projectDetail,
    statusField,
    priorityField,
    priority,
    includePriorityTemplates: !priorityField,
    runtime: "codex",
    skipSkills: flags.skipSkills,
    skipContext: flags.skipContext,
  });

  const runtime = await initRepoRuntime({
    repoDir: process.cwd(),
    workflowFile: workflowPath,
  });

  if (options.json) {
    process.stdout.write(
      JSON.stringify({
        status: "created",
        output: workflowPath,
        runtimeDir: runtime.configDir,
        repository: `${runtime.repository.owner}/${runtime.repository.name}`,
        githubProjectId: projectDetail.id,
      }) + "\n"
    );
    return;
  }

  printNonInteractiveSummary({
    githubProjectTitle: projectDetail.title,
    githubProjectId: projectDetail.id,
    workflowPath,
    runtimeDir: runtime.configDir,
    repository: `${runtime.repository.owner}/${runtime.repository.name}`,
  });
}

async function runInteractive(
  flags: SetupFlags,
  _options: GlobalOptions
): Promise<void> {
  p.intro("gh-symphony — One-command Setup");

  const authSpinner = p.spinner();
  authSpinner.start("Checking gh CLI authentication...");

  let login: string;
  let client: GitHubClient;

  try {
    const auth = ensureGhAuth();
    login = auth.login;
    client = createClient(auth.token);
    authSpinner.stop(`Authenticated as ${login}`);
  } catch (error) {
    authSpinner.stop("Authentication failed.");
    if (error instanceof GhAuthError) {
      if (error.code === "not_installed") {
        p.log.error(
          "gh CLI가 설치되어 있지 않습니다. https://cli.github.com 에서 설치하세요."
        );
      } else if (error.code === "not_authenticated") {
        p.log.error(
          "gh auth login --scopes repo,read:org,project 를 실행하세요."
        );
      } else if (error.code === "missing_scopes") {
        p.log.error(
          "gh auth refresh --scopes repo,read:org,project 를 실행하세요."
        );
      } else {
        p.log.error(error.message);
      }
    } else {
      p.log.error(error instanceof Error ? error.message : "Unknown error");
    }
    process.exitCode = 1;
    return;
  }

  const projectsSpinner = p.spinner();
  projectsSpinner.start("Loading GitHub Project boards...");

  let selectedProject: ProjectSummary;
  try {
    selectedProject = await selectProjectSummary(client);
    projectsSpinner.stop(`Selected: ${selectedProject.title}`);
  } catch (error) {
    projectsSpinner.stop("Failed to load projects.");
    if (error instanceof GitHubScopeError) {
      displayScopeError(error, "gh-symphony setup");
    } else {
      p.log.error(error instanceof Error ? error.message : "Unknown error");
    }
    process.exitCode = 1;
    return;
  }

  const detailSpinner = p.spinner();
  detailSpinner.start("Loading project details...");

  let projectDetail: ProjectDetail;
  try {
    projectDetail = await getProjectDetail(client, selectedProject.id);
    detailSpinner.stop(`Loaded: ${projectDetail.title}`);
  } catch (error) {
    detailSpinner.stop("Failed to load project details.");
    p.log.error(error instanceof Error ? error.message : "Unknown error");
    process.exitCode = 1;
    return;
  }

  const statusField = resolveStatusField(projectDetail);
  if (!statusField) {
    p.log.error(
      "No status field found on the project. The project needs a single-select 'Status' field."
    );
    process.exitCode = 1;
    return;
  }

  const priorityResolution = resolvePriorityField(projectDetail, statusField);
  const priorityLabelNames = await collectPriorityLabelNames(
    client,
    projectDetail.linkedRepositories
  );
  const mappings = await promptStateMappings(statusField, {
    stepLabel: "Step 2/4",
  });
  const workflowValidation = validateStateMapping(mappings);
  if (!workflowValidation.valid) {
    p.log.error("Mapping validation failed:");
    for (const error of workflowValidation.errors) {
      p.log.error(`  • ${error}`);
    }
    process.exitCode = 1;
    return;
  }
  for (const warning of workflowValidation.warnings) {
    p.log.warn(`  ⚠ ${warning}`);
  }

  const lifecycleBase = toWorkflowLifecycleConfig(statusField.name, mappings);
  const blockerCheckStates = await promptBlockerCheck(lifecycleBase, {
    stepLabel: "Step 3/4",
  });
  const lifecycle = toWorkflowLifecycleConfig(statusField.name, mappings, {
    blockerCheckStates,
    planningStates: blockerCheckStates,
  });

  const { priority, priorityField } = await promptPriorityConfig({
    priorityResolution,
    labelNames: priorityLabelNames,
    stepLabel: "Step 4/4",
  });

  const workflowPath = resolve(flags.output ?? "WORKFLOW.md");
  const { workflowPlan, ecosystemPlan } = await planWorkflowArtifacts({
    cwd: process.cwd(),
    outputPath: workflowPath,
    projectDetail,
    statusField,
    priorityField,
    priority,
    includePriorityTemplates: priority.source === "disabled",
    mappings,
    lifecycle,
    runtime: "codex",
    skipSkills: flags.skipSkills,
    skipContext: flags.skipContext,
  });

  p.note(
    [
      `GitHub Project: ${projectDetail.title}`,
      `Authenticated:  ${login}`,
      `Repository:     current working directory`,
      "",
      renderDryRunPreview(workflowPath, workflowPlan, ecosystemPlan).trimEnd(),
    ].join("\n"),
    "Final summary"
  );

  const confirmed = await abortIfCancelled(
    p.confirm({ message: "Write files and register this managed project?" })
  );

  if (!confirmed) {
    p.cancel("Setup cancelled.");
    process.exitCode = 130;
    return;
  }

  const writeSpinner = p.spinner();
  writeSpinner.start("Writing setup files...");

  try {
    await writeWorkflowPlan(workflowPlan);
    await writeEcosystem({
      cwd: process.cwd(),
      projectDetail,
      statusField,
      priorityField,
      priority,
      lifecycle,
      includePriorityTemplates: priority.source === "disabled",
      runtime: "codex",
      skipSkills: flags.skipSkills,
      skipContext: flags.skipContext,
    });
    const runtime = await initRepoRuntime({
      repoDir: process.cwd(),
      workflowFile: workflowPath,
    });
    writeSpinner.stop(
      `Setup saved for ${runtime.repository.owner}/${runtime.repository.name}.`
    );
  } catch (error) {
    writeSpinner.stop("Setup failed.");
    p.log.error(error instanceof Error ? error.message : "Unknown error");
    process.exitCode = 1;
    return;
  }

  p.outro(
    "Repository runtime is ready.\n  Run 'gh-symphony repo start' to begin orchestration."
  );
}
