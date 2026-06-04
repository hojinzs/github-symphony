import { execFileSync } from "node:child_process";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  parseWorkflowMarkdown,
  type OrchestratorProjectConfig,
  type OrchestratorTrackerSettingValue,
  type RepositoryRef,
} from "@gh-symphony/core";
import {
  saveGlobalConfig,
  saveProjectConfig,
  type CliProjectConfig,
} from "./config.js";
import { resolveRepoRuntimeRoot } from "./orchestrator-runtime.js";

export type RepoInitFlags = {
  repoDir: string;
  workflowFile?: string;
};

const INTERNAL_PROJECT_ID = "repository";

export class RepoRuntimeMigrationError extends Error {}

export function parseRepoRuntimeFlags(args: readonly string[]): RepoInitFlags {
  const flags: RepoInitFlags = { repoDir: process.cwd() };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const value = args[i + 1];
    if (arg === "--repo-dir") {
      if (!value || value.startsWith("-")) {
        throw new Error("Option '--repo-dir' argument missing");
      }
      flags.repoDir = resolve(value);
      i += 1;
      continue;
    }
    if (arg === "--workflow-file") {
      if (!value || value.startsWith("-")) {
        throw new Error("Option '--workflow-file' argument missing");
      }
      flags.workflowFile = value;
      i += 1;
      continue;
    }
    if (arg?.startsWith("-")) {
      throw new Error(`Unknown option '${arg}'`);
    }
  }

  return flags;
}

export async function initRepoRuntime(flags: RepoInitFlags): Promise<{
  configDir: string;
  projectId: string;
  workflowPath: string;
  repository: RepositoryRef;
}> {
  const repoDir = resolve(flags.repoDir);
  const runtimeRoot = resolveRepoRuntimeRoot(repoDir);
  await migrateLegacyRuntime(runtimeRoot);

  const workflowPath = resolve(repoDir, flags.workflowFile ?? "WORKFLOW.md");
  const workflow = parseWorkflowMarkdown(await readFile(workflowPath, "utf8"));
  validateRepoInitWorkflow(workflow);
  const repository = resolveRepository(repoDir);
  const trackerAdapter = workflow.tracker.kind ?? "github-project";
  const trackerBindingId =
    workflow.tracker.projectId ?? workflow.tracker.projectSlug ?? "";
  const trackerSettings: Record<string, OrchestratorTrackerSettingValue> = {
    ...(workflow.tracker.projectId
      ? { projectId: workflow.tracker.projectId }
      : {}),
    ...(workflow.tracker.projectSlug
      ? { projectSlug: workflow.tracker.projectSlug }
      : {}),
    ...(trackerAdapter === "linear"
      ? { activeStates: workflow.tracker.activeStates.join("\n") }
      : {}),
    repository: `${repository.owner}/${repository.name}`,
  };
  if (
    trackerAdapter === "linear" &&
    (workflow.tracker.pickupLabels.include.length > 0 ||
      workflow.tracker.pickupLabels.exclude.length > 0)
  ) {
    trackerSettings.pickupLabels = workflow.tracker.pickupLabels;
  }
  if (workflow.tracker.priorityFieldName) {
    trackerSettings.priorityFieldName = workflow.tracker.priorityFieldName;
  }
  if (trackerAdapter === "file") {
    if (!process.env.GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH) {
      throw new Error(
        "File tracker repo init requires GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH to point to the issues fixture."
      );
    }
    // E2E-only escape hatch for binding the file tracker to a mounted fixture.
    trackerSettings.issuesPath =
      process.env.GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH;
  }
  const projectConfig: CliProjectConfig = {
    projectId: INTERNAL_PROJECT_ID,
    slug: basename(repoDir) || INTERNAL_PROJECT_ID,
    displayName: `${repository.owner}/${repository.name}`,
    workspaceDir: repoDir,
    repository,
    tracker: {
      adapter: trackerAdapter,
      bindingId: trackerBindingId,
      ...(workflow.tracker.endpoint
        ? { apiUrl: workflow.tracker.endpoint }
        : {}),
      priority: workflow.tracker.priority,
      settings: trackerSettings,
    },
  };

  await mkdir(runtimeRoot, { recursive: true });
  await saveProjectConfig(runtimeRoot, INTERNAL_PROJECT_ID, projectConfig);
  await saveGlobalConfig(runtimeRoot, {
    activeProject: INTERNAL_PROJECT_ID,
    projects: [INTERNAL_PROJECT_ID],
  });

  const orchestratorConfig: OrchestratorProjectConfig = {
    projectId: INTERNAL_PROJECT_ID,
    slug: projectConfig.slug,
    workspaceDir: repoDir,
    repository,
    tracker: projectConfig.tracker,
  };
  await writeJsonFile(join(runtimeRoot, "project.json"), orchestratorConfig);

  return {
    configDir: runtimeRoot,
    projectId: INTERNAL_PROJECT_ID,
    workflowPath,
    repository,
  };
}

function validateRepoInitWorkflow(
  workflow: ReturnType<typeof parseWorkflowMarkdown>
): void {
  if (workflow.tracker.kind !== "linear") {
    return;
  }

  if (!workflow.tracker.apiKey?.trim()) {
    throw new Error(
      'Linear tracker repo init requires WORKFLOW.md field "tracker.api_key" to reference a resolvable environment variable such as "$LINEAR_API_KEY".'
    );
  }
}

export async function migrateLegacyRuntime(runtimeRoot: string): Promise<void> {
  const projectsDir = join(runtimeRoot, "projects");
  const projectIds = await readDirectoryNames(projectsDir);
  if (projectIds.length === 0) {
    return;
  }

  if (
    projectIds.length === 1 &&
    projectIds[0] === INTERNAL_PROJECT_ID &&
    (await pathExists(join(runtimeRoot, "project.json")))
  ) {
    return;
  }

  if (projectIds.length > 1) {
    throw new RepoRuntimeMigrationError(
      [
        "Multiple legacy project runtime directories were found under .runtime/orchestrator/projects.",
        `Found: ${projectIds.join(", ")}`,
        "Automatic migration is only supported when exactly one project directory exists.",
        "Manually keep the project directory you want to promote, archive or remove the others, then re-run 'gh-symphony repo init'.",
      ].join("\n")
    );
  }

  const sourceDir = join(projectsDir, projectIds[0]!);
  const entries = await readdir(sourceDir);
  for (const entry of entries) {
    const target = join(runtimeRoot, entry);
    if (await pathExists(target)) {
      throw new RepoRuntimeMigrationError(
        `Cannot promote legacy runtime data because '${entry}' already exists in .runtime/orchestrator. Move or remove it, then re-run 'gh-symphony repo init'.`
      );
    }
    await rename(join(sourceDir, entry), target);
  }

  await stripProjectIdFromRunRecords(join(runtimeRoot, "runs"));
  await rm(projectsDir, { recursive: true, force: true });
}

async function stripProjectIdFromRunRecords(runsDir: string): Promise<void> {
  for (const runId of await readDirectoryNames(runsDir)) {
    const runPath = join(runsDir, runId, "run.json");
    const run = await readJsonFile<Record<string, unknown>>(runPath);
    if (!run || !("projectId" in run)) {
      continue;
    }
    delete run.projectId;
    await writeJsonFile(runPath, run);
  }
}

async function readDirectoryNames(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (isMissing(error)) {
      return [];
    }
    throw error;
  }
}

function resolveRepository(repoDir: string): RepositoryRef {
  const remote = readGitOrigin(repoDir);
  const cleanedRemote = remote.replace(/\.git$/, "");
  const match =
    cleanedRemote.match(/github\.com[:/]([^/]+)\/([^/]+)$/) ??
    cleanedRemote.match(/^([^/]+)\/([^/]+)$/);
  if (!match) {
    throw new Error(
      "Unable to infer GitHub repository from git remote 'origin'. Run from a cloned GitHub repository or set origin to owner/name."
    );
  }

  return {
    owner: match[1]!,
    name: match[2]!,
    cloneUrl: remote.startsWith("http")
      ? remote
      : `https://github.com/${match[1]}/${match[2]}.git`,
    path: repoDir,
  };
}

function readGitOrigin(repoDir: string): string {
  try {
    return execFileSync(
      "git",
      ["-C", repoDir, "config", "--get", "remote.origin.url"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }
    ).trim();
  } catch {
    throw new Error(
      "Unable to read git remote 'origin'. Run 'gh-symphony repo init' inside a cloned repository."
    );
  }
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(value, null, 2) + "\n", "utf8");
  await rename(temporaryPath, path);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}
