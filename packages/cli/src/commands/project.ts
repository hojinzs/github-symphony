import * as p from "@clack/prompts";
import type { GlobalOptions } from "../index.js";
import {
  createClient,
  validateToken,
  checkRequiredScopes,
  listUserProjects,
  getProjectDetail,
  GitHubScopeError,
  type GitHubClient,
  type ProjectSummary,
  type ProjectDetail,
} from "../github/client.js";
import { ensureGhAuth, getGhToken, GhAuthError } from "../github/gh-auth.js";
import {
  loadGlobalConfig,
  saveGlobalConfig,
  loadProjectConfig,
  projectConfigDir,
  type CliGlobalConfig,
} from "../config.js";
import { writeConfig, generateProjectId, abortIfCancelled } from "./init.js";

const KNOWN_REQUIRED_SCOPES = ["repo", "read:org", "project"] as const;

type ProjectAddFlags = {
  nonInteractive: boolean;
  project?: string;
  workspaceDir?: string;
  assignedOnly: boolean;
};

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
  const flags: ProjectAddFlags = { nonInteractive: false, assignedOnly: false };

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
    case "switch":
      await projectSwitch(options);
      return;
    case "status":
      await projectStatus(options);
      return;
    default:
      process.stdout.write(
        "Usage: gh-symphony project <add|list|remove|switch|status>\n"
      );
  }
};

export default handler;

async function projectAdd(
  args: string[],
  options: GlobalOptions
): Promise<void> {
  const flags = parseProjectAddFlags(args);

  if (flags.nonInteractive) {
    await projectAddNonInteractive(flags, options);
    return;
  }

  await projectAddInteractive(options);
}

async function projectAddNonInteractive(
  flags: ProjectAddFlags,
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
  const workspaceDir = flags.workspaceDir ?? `${options.configDir}/workspaces`;

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
    process.stdout.write(`Project created: ${projectId}\n`);
    process.stdout.write(`Run 'gh-symphony start' to begin orchestration.\n`);
  }
}

async function projectAddInteractive(options: GlobalOptions): Promise<void> {
  p.intro("gh-symphony - Project Setup");

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
  s1.start("Checking gh CLI authentication...");

  let login: string;
  let client: GitHubClient;

  try {
    const { login: ghLogin, token } = ensureGhAuth();
    login = ghLogin;
    client = createClient(token);
    s1.stop(`Authenticated as ${login}`);
  } catch (error) {
    s1.stop("Authentication failed.");
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

  const s2 = p.spinner();
  s2.start("Loading GitHub Project boards...");
  let projects: ProjectSummary[];
  try {
    projects = await listUserProjects(client);
    s2.stop(
      `Found ${projects.length} project${projects.length === 1 ? "" : "s"}`
    );
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
      message: "Step 1/4 - Select a GitHub Project board:",
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
      "No linked repositories found in this project. Add issues from repositories to the project first."
    );
    process.exitCode = 1;
    return;
  }

  const selectedRepos = await abortIfCancelled(
    p.multiselect({
      message: "Step 2/4 - Select repositories to orchestrate:",
      options: projectDetail.linkedRepositories.map((repo) => ({
        value: repo,
        label: `${repo.owner}/${repo.name}`,
      })),
      required: true,
    })
  );

  const assignedOnly = await abortIfCancelled(
    p.confirm({
      message:
        "Step 3/4 - Only process issues assigned to the authenticated GitHub user?",
      initialValue: false,
    })
  );

  const workspaceDir = await abortIfCancelled(
    p.text({
      message: "Step 4/4 - Workspace root directory:",
      placeholder: `${options.configDir}/workspaces`,
      defaultValue: `${options.configDir}/workspaces`,
      validate(value: string) {
        return value.trim().length > 0
          ? undefined
          : "Workspace directory is required.";
      },
    })
  );

  p.note(
    [
      `User:       ${login}`,
      `Project:    ${projectDetail.title}`,
      `Repos:      ${selectedRepos.map((repo) => `${repo.owner}/${repo.name}`).join(", ")}`,
      `Assigned:   ${assignedOnly ? `Only issues assigned to ${login}` : "All project issues"}`,
      `Workspace:  ${workspaceDir}`,
    ].join("\n"),
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

  p.outro(
    `Project "${projectId}" created.\n  Run 'gh-symphony start' to begin orchestration.`
  );
}

async function projectList(options: GlobalOptions): Promise<void> {
  const global = await loadGlobalConfig(options.configDir);
  if (!global?.projects?.length) {
    process.stdout.write("No projects configured.\n");
    return;
  }

  if (options.json) {
    const configs = await Promise.all(
      global.projects.map((projectId) =>
        loadProjectConfig(options.configDir, projectId)
      )
    );
    process.stdout.write(
      JSON.stringify(
        global.projects.map((projectId, index) => ({
          id: projectId,
          active: global.activeProject === projectId,
          repos: configs[index]?.repositories.length ?? 0,
        })),
        null,
        2
      ) + "\n"
    );
    return;
  }

  process.stdout.write("Configured projects:\n");
  const configs = await Promise.all(
    global.projects.map((projectId) =>
      loadProjectConfig(options.configDir, projectId)
    )
  );
  for (let index = 0; index < global.projects.length; index += 1) {
    const projectId = global.projects[index]!;
    const config = configs[index];
    const active = global.activeProject === projectId ? " (active)" : "";
    const slug = config?.slug ?? projectId;
    process.stdout.write(`  ${slug}${active}\n`);
  }
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

  const updatedProjects = global.projects.filter((entry) => entry !== projectId);
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
    process.stderr.write("No projects configured. Run 'gh-symphony init'.\n");
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

async function projectStatus(options: GlobalOptions): Promise<void> {
  const global = await loadGlobalConfig(options.configDir);
  if (!global?.activeProject) {
    process.stderr.write("No active project.\n");
    process.exitCode = 1;
    return;
  }

  const project = await loadProjectConfig(options.configDir, global.activeProject);
  if (!project) {
    process.stderr.write(`Project config missing: ${global.activeProject}\n`);
    process.exitCode = 1;
    return;
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(project, null, 2) + "\n");
    return;
  }

  process.stdout.write(`Project:     ${project.projectId}\n`);
  process.stdout.write(
    `Tracker:     ${project.tracker.adapter} (${project.tracker.bindingId})\n`
  );
  process.stdout.write("Repositories:\n");
  for (const repo of project.repositories) {
    process.stdout.write(`  - ${repo.owner}/${repo.name}\n`);
  }
}
