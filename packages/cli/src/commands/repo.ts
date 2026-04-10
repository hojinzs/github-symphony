import type { GlobalOptions } from "../index.js";
import {
  loadActiveProjectConfig,
  loadGlobalConfig,
  saveProjectConfig,
} from "../config.js";
import {
  checkRequiredScopes,
  createClient,
  getProjectDetail,
  GitHubScopeError,
  GitHubRepositoryLookupError,
  getRepositoryMetadata,
  validateToken,
  type LinkedRepository,
  type ProjectDetail,
} from "../github/client.js";
import { getGhToken } from "../github/gh-auth.js";

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => {
  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case "list":
      await repoList(options);
      break;
    case "add":
      await repoAdd(rest, options);
      break;
    case "remove":
      await repoRemove(rest, options);
      break;
    case "sync":
      await repoSync(rest, options);
      break;
    default:
      process.stderr.write(
        "Usage: gh-symphony repo <list|add|remove|sync> [repo]\n"
      );
      process.exitCode = 2;
  }
};

export default handler;

// ── 6.4: repo list / add / remove / sync ─────────────────────────────────────

type RepoConfigEntry = {
  owner: string;
  name: string;
  cloneUrl: string;
};

type RepoSyncFlags = {
  dryRun: boolean;
  prune: boolean;
};

type RepoSyncSummary = {
  projectId: string;
  githubProjectId: string;
  dryRun: boolean;
  prune: boolean;
  added: RepoConfigEntry[];
  removed: RepoConfigEntry[];
  unchanged: RepoConfigEntry[];
  repositories: RepoConfigEntry[];
};

function repoKey(repo: { owner: string; name: string }): string {
  return `${repo.owner}/${repo.name}`.toLowerCase();
}

function toRepoConfigEntry(repo: LinkedRepository): RepoConfigEntry {
  return {
    owner: repo.owner,
    name: repo.name,
    cloneUrl: repo.cloneUrl,
  };
}

function parseRepoSyncFlags(args: string[]): RepoSyncFlags {
  const flags: RepoSyncFlags = { dryRun: false, prune: false };

  for (const arg of args) {
    if (arg === "--dry-run") {
      flags.dryRun = true;
    } else if (arg === "--prune") {
      flags.prune = true;
    }
  }

  return flags;
}

function displayScopeError(error: GitHubScopeError): void {
  const plural = error.requiredScopes.length === 1 ? "" : "s";
  process.stderr.write(
    `Token is missing required scope${plural}: ${error.requiredScopes.join(", ")}\n`
  );

  const currentSet = new Set(error.currentScopes.map((scope) => scope.toLowerCase()));
  const scopesToAdd = ["repo", "read:org", "project"].filter(
    (scope) => !currentSet.has(scope)
  );
  const scopeArg =
    scopesToAdd.length > 0
      ? scopesToAdd.join(",")
      : error.requiredScopes.join(",");
  process.stderr.write(
    `Run 'gh auth refresh --scopes ${scopeArg}' and try again.\n`
  );
}

function formatRepoSpec(repo: { owner: string; name: string }): string {
  return `${repo.owner}/${repo.name}`;
}

function fallbackCloneUrl(repo: { owner: string; name: string }): string {
  return `https://github.com/${repo.owner}/${repo.name}.git`;
}

function sortRepos(repos: RepoConfigEntry[]): RepoConfigEntry[] {
  return [...repos].sort((left, right) =>
    formatRepoSpec(left).localeCompare(formatRepoSpec(right))
  );
}

function renderRepoGroup(label: string, repos: RepoConfigEntry[]): string[] {
  if (repos.length === 0) {
    return [`${label}: none`];
  }

  return [label, ...sortRepos(repos).map((repo) => `  ${formatRepoSpec(repo)}`)];
}

function buildSyncedRepositories(
  currentRepos: RepoConfigEntry[],
  linkedMap: Map<string, LinkedRepository>,
  linkedRepositories: LinkedRepository[],
  prune: boolean
): RepoConfigEntry[] {
  const retained = currentRepos
    .filter((repo) => linkedMap.has(repoKey(repo)) || !prune)
    .map((repo) => {
      const linked = linkedMap.get(repoKey(repo));
      return linked ? toRepoConfigEntry(linked) : { ...repo };
    });
  const currentKeys = new Set(currentRepos.map((repo) => repoKey(repo)));
  const additions = sortRepos(
    linkedRepositories
      .filter((repo) => !currentKeys.has(repoKey(repo)))
      .map(toRepoConfigEntry)
  );

  return [...retained, ...additions];
}

function writeRepoSummary(summary: RepoSyncSummary, options: GlobalOptions): void {
  if (options.json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return;
  }

  process.stdout.write(
    [
      `Repository sync ${summary.dryRun ? "preview" : "complete"} for ${summary.projectId}`,
      `Mode: ${summary.prune ? "prune" : "additive"}`,
      ...renderRepoGroup("Added", summary.added),
      ...renderRepoGroup("Removed", summary.removed),
      ...renderRepoGroup("Unchanged", summary.unchanged),
      summary.dryRun ? "No config changes written." : "Configuration updated.",
    ].join("\n") + "\n"
  );
}

async function repoList(options: GlobalOptions): Promise<void> {
  const ws = await loadActiveProjectConfig(options.configDir);
  if (!ws) {
    process.stderr.write("No project configured.\n");
    process.exitCode = 1;
    return;
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(ws.repositories, null, 2) + "\n");
    return;
  }

  process.stdout.write("Repositories:\n");
  for (const repo of ws.repositories) {
    process.stdout.write(`  ${repo.owner}/${repo.name}\n`);
  }
}

async function repoAdd(args: string[], options: GlobalOptions): Promise<void> {
  const [repoSpec] = args;
  if (!repoSpec || !repoSpec.includes("/")) {
    process.stderr.write("Usage: gh-symphony repo add <owner/name>\n");
    process.exitCode = 2;
    return;
  }

  const global = await loadGlobalConfig(options.configDir);
  if (!global?.activeProject) {
    process.stderr.write("No active project.\n");
    process.exitCode = 1;
    return;
  }

  const ws = await loadActiveProjectConfig(options.configDir);
  if (!ws) {
    process.stderr.write("Project config missing.\n");
    process.exitCode = 1;
    return;
  }
  const activeProjectId = global.activeProject;

  const [owner, name] = repoSpec.split("/");
  if (!owner || !name) {
    process.stderr.write("Invalid repo format. Use: owner/name\n");
    process.exitCode = 2;
    return;
  }

  const requestedRepo = { owner, name };
  const addRepository = async (
    repo: RepoConfigEntry,
    message: string,
    warning?: string
  ): Promise<void> => {
    if (ws.repositories.some((entry: RepoConfigEntry) => repoKey(entry) === repoKey(repo))) {
      process.stdout.write(
        `Repository ${formatRepoSpec(repo)} is already configured.\n`
      );
      return;
    }

    ws.repositories.push(repo);
    await saveProjectConfig(options.configDir, activeProjectId, ws);

    if (warning) {
      process.stderr.write(`${warning}\n`);
    }
    process.stdout.write(`${message}\n`);
  };

  let token: string;
  try {
    token = getGhToken();
  } catch {
    await addRepository(
      {
        ...requestedRepo,
        cloneUrl: fallbackCloneUrl(requestedRepo),
      },
      `Added repository without validation: ${formatRepoSpec(requestedRepo)}`,
      "Warning: GitHub authentication is unavailable, so the repository was saved without validation. Run 'gh auth login --scopes repo,read:org,project' or set GITHUB_GRAPHQL_TOKEN to validate access before saving."
    );
    return;
  }

  try {
    const repository = await getRepositoryMetadata(createClient(token), owner, name);
    await addRepository(
      {
        owner: repository.owner,
        name: repository.name,
        cloneUrl: repository.cloneUrl || fallbackCloneUrl(repository),
      },
      `Added repository after validation: ${formatRepoSpec(repository)}`
    );
  } catch (error) {
    if (
      error instanceof GitHubRepositoryLookupError &&
      error.reason === "offline"
    ) {
      await addRepository(
        {
          ...requestedRepo,
          cloneUrl: fallbackCloneUrl(requestedRepo),
        },
        `Added repository without validation: ${formatRepoSpec(requestedRepo)}`,
        `Warning: ${error.message} Saved the repository without validation. ${error.remediation}`
      );
      return;
    }

    if (error instanceof GitHubRepositoryLookupError) {
      process.stderr.write(`${error.message}\n${error.remediation}\n`);
    } else {
      process.stderr.write(
        `${error instanceof Error ? error.message : "Repository validation failed."}\n`
      );
    }
    process.exitCode = 1;
  }
}

async function repoRemove(
  args: string[],
  options: GlobalOptions
): Promise<void> {
  const [repoSpec] = args;
  if (!repoSpec || !repoSpec.includes("/")) {
    process.stderr.write("Usage: gh-symphony repo remove <owner/name>\n");
    process.exitCode = 2;
    return;
  }

  const global = await loadGlobalConfig(options.configDir);
  if (!global?.activeProject) {
    process.stderr.write("No active project.\n");
    process.exitCode = 1;
    return;
  }

  const ws = await loadActiveProjectConfig(options.configDir);
  if (!ws) {
    process.stderr.write("Project config missing.\n");
    process.exitCode = 1;
    return;
  }

  const [owner, name] = repoSpec.split("/");
  const requestedRepo = { owner, name };
  const idx = ws.repositories.findIndex(
    (r: RepoConfigEntry) => repoKey(r) === repoKey(requestedRepo)
  );

  if (idx === -1) {
    process.stderr.write(`Repository ${repoSpec} is not configured.\n`);
    process.exitCode = 1;
    return;
  }

  ws.repositories.splice(idx, 1);
  await saveProjectConfig(options.configDir, global.activeProject, ws);
  process.stdout.write(`Removed repository: ${formatRepoSpec(requestedRepo)}\n`);
}

async function repoSync(args: string[], options: GlobalOptions): Promise<void> {
  const flags = parseRepoSyncFlags(args);
  const global = await loadGlobalConfig(options.configDir);
  if (!global?.activeProject) {
    process.stderr.write("No active project.\n");
    process.exitCode = 1;
    return;
  }

  const ws = await loadActiveProjectConfig(options.configDir);
  if (!ws) {
    process.stderr.write("Project config missing.\n");
    process.exitCode = 1;
    return;
  }

  const projectBindingId =
    typeof ws.tracker.settings?.projectId === "string"
      ? ws.tracker.settings.projectId
      : ws.tracker.bindingId;

  if (!projectBindingId) {
    process.stderr.write(
      "Active project is missing its GitHub Project binding. Re-run 'gh-symphony project add'.\n"
    );
    process.exitCode = 1;
    return;
  }

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

  try {
    const viewer = await validateToken(client);
    const scopeCheck = checkRequiredScopes(viewer.scopes);
    if (!scopeCheck.valid) {
      process.stderr.write(
        `Error: Missing required PAT scopes: ${scopeCheck.missing.join(", ")}\n`
      );
      process.exitCode = 1;
      return;
    }
  } catch {
    process.stderr.write("Error: Invalid GitHub token.\n");
    process.exitCode = 1;
    return;
  }

  let projectDetail: ProjectDetail;
  try {
    projectDetail = await getProjectDetail(client, projectBindingId);
  } catch (error) {
    if (error instanceof GitHubScopeError) {
      displayScopeError(error);
    } else {
      process.stderr.write(
        `${error instanceof Error ? error.message : "Failed to load linked repositories."}\n`
      );
    }
    process.exitCode = 1;
    return;
  }

  const currentRepos: RepoConfigEntry[] = ws.repositories;
  const currentMap = new Map<string, RepoConfigEntry>(
    currentRepos.map((repo: RepoConfigEntry) => [repoKey(repo), repo])
  );
  const linkedMap = new Map<string, LinkedRepository>(
    projectDetail.linkedRepositories.map((repo: LinkedRepository) => [
      repoKey(repo),
      repo,
    ])
  );

  const added = projectDetail.linkedRepositories
    .filter((repo: LinkedRepository) => !currentMap.has(repoKey(repo)))
    .map(toRepoConfigEntry);
  const removed = flags.prune
    ? currentRepos
        .filter((repo: RepoConfigEntry) => !linkedMap.has(repoKey(repo)))
        .map((repo: RepoConfigEntry) => ({ ...repo }))
    : [];
  const unchanged = flags.prune
    ? currentRepos
        .filter((repo: RepoConfigEntry) => linkedMap.has(repoKey(repo)))
        .map((repo: RepoConfigEntry) => {
          const linked = linkedMap.get(repoKey(repo));
          return linked ? toRepoConfigEntry(linked) : { ...repo };
        })
    : currentRepos.map((repo: RepoConfigEntry) => {
        const linked = linkedMap.get(repoKey(repo));
        return linked ? toRepoConfigEntry(linked) : { ...repo };
      });

  const nextRepositories = buildSyncedRepositories(
    currentRepos,
    linkedMap,
    projectDetail.linkedRepositories,
    flags.prune
  );

  if (!flags.dryRun) {
    await saveProjectConfig(options.configDir, global.activeProject, {
      ...ws,
      repositories: nextRepositories,
    });
  }

  writeRepoSummary(
    {
      projectId: global.activeProject,
      githubProjectId: projectBindingId,
      dryRun: flags.dryRun,
      prune: flags.prune,
      added,
      removed,
      unchanged,
      repositories: nextRepositories,
    },
    options
  );
}
