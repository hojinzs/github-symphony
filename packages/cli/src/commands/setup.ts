import * as p from "@clack/prompts";
import { join, resolve } from "node:path";
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
import { ensureGhAuth, getGhToken, GhAuthError } from "../github/gh-auth.js";
import {
  abortIfCancelled,
  buildAutomaticStateMappings,
  generateProjectId,
  planWorkflowArtifacts,
  resolvePriorityField,
  renderDryRunPreview,
  resolveStatusField,
  writeConfig,
  writeEcosystem,
  writeWorkflowPlan,
  promptStateMappings,
} from "./init.js";
import { validateStateMapping } from "../mapping/smart-defaults.js";
import {
  promptProjectRegistrationOptions,
  renderProjectRegistrationSummary,
} from "./project.js";

const KNOWN_REQUIRED_SCOPES = ["repo", "read:org", "project"] as const;

type SetupFlags = {
  nonInteractive: boolean;
  project?: string;
  workspaceDir?: string;
  assignedOnly?: boolean;
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

async function resolveProjectDetail(
  client: GitHubClient,
  projectArg?: string
): Promise<ProjectDetail> {
  const projects = await listUserProjects(client);

  if (projects.length === 0) {
    throw new Error(
      "No GitHub Projects found. Create a project first and re-run setup."
    );
  }

  if (projectArg) {
    const match = projects.find(
      (project) => project.id === projectArg || project.url === projectArg
    );
    if (!match) {
      throw new Error(`Project not found: ${projectArg}`);
    }
    return getProjectDetail(client, match.id);
  }

  if (projects.length === 1) {
    return getProjectDetail(client, projects[0]!.id);
  }

  throw new Error("Error: --project is required when multiple projects exist.");
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
      message: "Step 1/3 — Select a GitHub Project board:",
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

function formatRepoSummary(
  projectDetail: ProjectDetail,
  selectedRepos: ProjectDetail["linkedRepositories"]
): string {
  return selectedRepos.length === projectDetail.linkedRepositories.length
    ? `${selectedRepos.map((repo) => `${repo.owner}/${repo.name}`).join(", ")}  (all ${selectedRepos.length} linked)`
    : `${selectedRepos.map((repo) => `${repo.owner}/${repo.name}`).join(", ")}  (${selectedRepos.length} of ${projectDetail.linkedRepositories.length} linked)`;
}

function printNonInteractiveSummary(input: {
  projectId: string;
  githubProjectTitle: string;
  githubProjectId: string;
  workflowPath: string;
  workspaceDir: string;
}): void {
  process.stdout.write(
    [
      `GitHub Project   ${input.githubProjectTitle}  (${input.githubProjectId})`,
      `Managed project  ${input.projectId}`,
      `WORKFLOW.md      ${input.workflowPath}`,
      `Workspace root   ${input.workspaceDir}`,
      "Ready. Run 'gh-symphony start' to begin orchestration.",
    ]
      .map((line) => `  ${line}`)
      .join("\n") + "\n"
  );
}

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => {
  const flags = parseSetupFlags(args);

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
    projectDetail = await resolveProjectDetail(client, flags.project);
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
      `Warning: Multiple priority-like single-select fields found (${ambiguousPriorityFields.map((field) => `"${field.name}"`).join(", ")}). Skipping tracker.priority_field in non-interactive mode.\n`
    );
  }
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
    runtime: "codex",
    skipSkills: flags.skipSkills,
    skipContext: flags.skipContext,
  });

  const projectId = generateProjectId(projectDetail.title, projectDetail.id);
  const workspaceDir = flags.workspaceDir ?? join(options.configDir, "workspaces");

  await writeConfig(options.configDir, {
    projectId,
    project: projectDetail,
    repos: projectDetail.linkedRepositories,
    workspaceDir,
    assignedOnly: flags.assignedOnly,
  });

  if (options.json) {
    process.stdout.write(
      JSON.stringify({
        status: "created",
        output: workflowPath,
        projectId,
        githubProjectId: projectDetail.id,
      }) + "\n"
    );
    return;
  }

  printNonInteractiveSummary({
    projectId,
    githubProjectTitle: projectDetail.title,
    githubProjectId: projectDetail.id,
    workflowPath,
    workspaceDir,
  });
}

async function runInteractive(
  flags: SetupFlags,
  options: GlobalOptions
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
        p.log.error("gh CLI가 설치되어 있지 않습니다. https://cli.github.com 에서 설치하세요.");
      } else if (error.code === "not_authenticated") {
        p.log.error("gh auth login --scopes repo,read:org,project 를 실행하세요.");
      } else if (error.code === "missing_scopes") {
        p.log.error("gh auth refresh --scopes repo,read:org,project 를 실행하세요.");
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

  if (projectDetail.linkedRepositories.length === 0) {
    p.log.error(
      "No linked repositories found in this project. Add issues from repositories to the project first."
    );
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
  const mappings = await promptStateMappings(statusField, {
    stepLabel: priorityResolution.ambiguous.length > 0 ? "Step 2/4" : "Step 2/3",
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

  const priorityField =
    priorityResolution.ambiguous.length > 0
      ? await (async () => {
          const selectedId = await abortIfCancelled(
            p.select({
              message:
                "Step 3/4 — Multiple GitHub Project priority fields look plausible. Select the one Symphony should use:",
              options: [
                ...priorityResolution.ambiguous.map((field) => ({
                  value: field.id,
                  label: field.name,
                  hint: `${field.options.length} option${field.options.length === 1 ? "" : "s"}`,
                })),
                {
                  value: "__skip_priority_field__",
                  label: "Skip priority-aware dispatch",
                  hint: "Leave tracker.priority_field unset",
                },
              ],
            })
          );
          if (selectedId === "__skip_priority_field__") {
            return null;
          }
          return (
            priorityResolution.ambiguous.find((field) => field.id === selectedId) ??
            null
          );
        })()
      : priorityResolution.field;

  const {
    assignedOnly: promptAssignedOnly,
    selectedRepos,
    workspaceDir,
  } =
    await promptProjectRegistrationOptions({
      projectDetail,
      defaultWorkspaceDir: flags.workspaceDir ?? join(options.configDir, "workspaces"),
      assignedOnlyMessage:
        `${
          priorityResolution.ambiguous.length > 0 ? "Step 4/4" : "Step 3/3"
        } — Only process issues assigned to the authenticated GitHub user?`,
      assignedOnlyInitialValue: flags.assignedOnly,
    });
  const assignedOnly = flags.assignedOnly || promptAssignedOnly;

  const workflowPath = resolve(flags.output ?? "WORKFLOW.md");
  const { workflowPlan, ecosystemPlan } = await planWorkflowArtifacts({
    cwd: process.cwd(),
    outputPath: workflowPath,
    projectDetail,
    statusField,
    priorityField,
    mappings,
    runtime: "codex",
    skipSkills: flags.skipSkills,
    skipContext: flags.skipContext,
  });

  const projectId = generateProjectId(projectDetail.title, projectDetail.id);
  p.note(
    [
      renderProjectRegistrationSummary({
        login,
        projectTitle: projectDetail.title,
        repoSummary: formatRepoSummary(projectDetail, selectedRepos),
        assignedOnly,
        workspaceDir,
      }),
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
      runtime: "codex",
      skipSkills: flags.skipSkills,
      skipContext: flags.skipContext,
    });
    await writeConfig(options.configDir, {
      projectId,
      project: projectDetail,
      repos: selectedRepos,
      workspaceDir,
      assignedOnly,
    });
    writeSpinner.stop("Setup saved.");
  } catch (error) {
    writeSpinner.stop("Setup failed.");
    p.log.error(error instanceof Error ? error.message : "Unknown error");
    process.exitCode = 1;
    return;
  }

  p.outro(
    `Project "${projectId}" is ready.\n  Run 'gh-symphony start' to begin orchestration.`
  );
}
