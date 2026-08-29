import { readFile, readdir } from "node:fs/promises";
import { basename, resolve } from "node:path";
import * as p from "@clack/prompts";
import {
  normalizeLabels,
  parseWorkflowMarkdown,
  type OrchestratorTrackerSettingValue,
  type RepositoryRef,
} from "@gh-symphony/core";
import type { GlobalOptions } from "../index.js";
import startCommand from "./start.js";
import statusCommand from "./status.js";
import stopCommand from "./stop.js";
import {
  loadProjectConfig,
  saveProjectConfigWithinLock,
  type CliProjectConfig,
  withConfigLock,
} from "../config.js";
import { resolveDaemonLiveness } from "../daemon-liveness.js";
import { standaloneProjectId } from "../standalone-project.js";
import { listInstances } from "../instances.js";

export { standaloneProjectId } from "../standalone-project.js";

type PickupLabels = { include: string[]; exclude: string[] };

type Mapping = {
  adapter: string;
  bindingId: string;
  states: string[];
  labels: PickupLabels;
};

/**
 * The project folder is the source of truth: every field below is derived from
 * it, so the stored config is a cache that each start refreshes rather than a
 * registration the operator has to perform first.
 */
export async function deriveStandaloneProject(
  projectDirInput: string,
  options: Pick<GlobalOptions, "configDir">
): Promise<CliProjectConfig> {
  const projectDir = resolve(projectDirInput);
  const workflowPath = resolve(projectDir, "WORKFLOW.md");
  let markdown: string;
  try {
    markdown = await readFile(workflowPath, "utf8");
  } catch {
    throw new Error(
      `No WORKFLOW.md in ${projectDir}. Run this command from a standalone project folder or pass --project-dir <path>.`
    );
  }
  const workflow = parseWorkflowMarkdown(markdown, process.env);
  const repository = parseRepository(workflow.repository);
  const adapter = workflow.tracker.kind ?? "github-project";
  const bindingId =
    workflow.tracker.projectId ?? workflow.tracker.projectSlug ?? "";
  if (!bindingId) {
    throw new Error(
      "WORKFLOW.md tracker configuration requires project_id or project_slug."
    );
  }
  const projectId = standaloneProjectId(projectDir);
  const config: CliProjectConfig = {
    projectId,
    slug: slugify(basename(projectDir)) || projectId,
    displayName: basename(projectDir) || projectId,
    projectDir,
    workspaceDir: workflow.workspace.root
      ? resolve(projectDir, workflow.workspace.root)
      : resolve(projectDir, ".runtime", "workspaces"),
    repository,
    workflowSource: { type: "external", path: workflowPath },
    populateStrategy: "worktree-cache",
    tracker: {
      adapter,
      bindingId,
      ...(workflow.tracker.endpoint
        ? { apiUrl: workflow.tracker.endpoint }
        : {}),
      priority: workflow.tracker.priority,
      settings: trackerSettings(workflow, repository),
    },
  };

  await withConfigLock(options.configDir, async () => {
    const overlap = await findOverlappingProjects(options.configDir, config);
    const running = overlap.filter((entry) => entry.running);
    const describe = (entries: OverlappingProject[]): string =>
      entries.map((entry) => entry.label).join(", ");
    if (running.length > 0) {
      // A live instance with an overlapping mapping would dispatch the same
      // issues, so this is refused outright rather than confirmed away.
      throw new Error(
        `Tracker mapping overlaps running project(s): ${describe(running)}. Stop them or make the mappings disjoint with tracker.pickup_labels.`
      );
    }
    if (overlap.length > 0 && !process.stdin.isTTY) {
      throw new Error(
        `Tracker mapping overlaps project(s): ${describe(overlap)}. Re-run interactively to confirm.`
      );
    }
    if (overlap.length > 0) {
      const confirmed = await p.confirm({
        message: `Tracker mapping overlaps project(s): ${describe(overlap)}. Continue anyway?`,
        initialValue: false,
      });
      if (p.isCancel(confirmed) || !confirmed) {
        throw new Error(
          "Standalone project start cancelled because tracker mappings overlap."
        );
      }

      // Project mappings cannot change while the config lock is held, but a
      // daemon can start while the operator is deciding. Refresh only that
      // liveness state before persisting the confirmed configuration.
      const runningAfterConfirmation = await runningOverlaps(
        options.configDir,
        overlap
      );
      if (runningAfterConfirmation.length > 0) {
        throw new Error(
          `Tracker mapping overlaps running project(s): ${describe(runningAfterConfirmation)}. Stop them or make the mappings disjoint with tracker.pickup_labels.`
        );
      }
    }

    await saveProjectConfigWithinLock(options.configDir, projectId, config);
  });
  return config;
}

/**
 * The identifier is a pure function of the folder path, so a project can be
 * addressed without reading its configuration first.
 */
async function listStandaloneProjects(
  configDir: string
): Promise<CliProjectConfig[]> {
  let entries: string[];
  try {
    entries = await readdir(resolve(configDir, "projects"));
  } catch {
    return [];
  }

  const configs = await Promise.all(
    entries.map((projectId) => loadProjectConfig(configDir, projectId))
  );
  return configs.filter(
    (config): config is CliProjectConfig =>
      config?.workflowSource?.type === "external"
  );
}

/** Splits `--project-dir <path>` out of the flags forwarded to the runtime. */
function extractProjectDir(args: string[]): {
  projectDir: string | null;
  forwarded: string[];
  error?: string;
} {
  const forwarded: string[] = [];
  let projectDir: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--project-dir") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) {
        return {
          projectDir: null,
          forwarded,
          error: "Option '--project-dir' requires a directory path",
        };
      }
      projectDir = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--project-dir=")) {
      const value = arg.slice("--project-dir=".length);
      if (!value) {
        return {
          projectDir: null,
          forwarded,
          error: "Option '--project-dir' requires a directory path",
        };
      }
      projectDir = value;
      continue;
    }
    forwarded.push(arg);
  }
  return { projectDir, forwarded };
}

type OverlappingProject = {
  projectId: string;
  label: string;
  running: boolean;
  workspaceDir: string;
};

/**
 * Runs on every start rather than once at registration, so an edited
 * `pickup_labels` cannot leave two projects competing for the same issues, and
 * so a conflict with an already running instance is detectable.
 */
async function findOverlappingProjects(
  configDir: string,
  candidate: CliProjectConfig
): Promise<OverlappingProject[]> {
  const candidateMapping = mappingFor(candidate);
  const overlaps: OverlappingProject[] = [];
  for (const existing of await listStandaloneProjects(configDir)) {
    if (existing.projectId === candidate.projectId) continue;
    if (
      existing.repository?.owner !== candidate.repository?.owner ||
      existing.repository?.name !== candidate.repository?.name
    )
      continue;
    if (!mappingsOverlap(candidateMapping, mappingFor(existing))) continue;

    const liveness = await resolveDaemonLiveness({
      configDir,
      projectId: existing.projectId,
      workspaceDir: existing.repositoryDir ?? existing.workspaceDir,
    });
    overlaps.push({
      projectId: existing.projectId,
      label: existing.projectDir ?? existing.projectId,
      running: liveness.running,
      workspaceDir: existing.repositoryDir ?? existing.workspaceDir,
    });
  }
  return overlaps;
}

async function runningOverlaps(
  configDir: string,
  overlaps: OverlappingProject[]
): Promise<OverlappingProject[]> {
  const refreshed = await Promise.all(
    overlaps.map(async (overlap) => ({
      ...overlap,
      running: (
        await resolveDaemonLiveness({
          configDir,
          projectId: overlap.projectId,
          workspaceDir: overlap.workspaceDir,
        })
      ).running,
    }))
  );
  return refreshed.filter((overlap) => overlap.running);
}

function mappingFor(config: CliProjectConfig): Mapping {
  const labels = config.tracker.settings?.pickupLabels;
  return {
    adapter: config.tracker.adapter,
    bindingId: config.tracker.bindingId,
    states: normalizeStates(config.tracker.settings?.activeStates),
    labels: normalizePickupLabels(labels),
  };
}

function mappingsOverlap(left: Mapping, right: Mapping): boolean {
  if (left.adapter !== right.adapter || left.bindingId !== right.bindingId)
    return false;
  return (
    intersects(left.states, right.states) &&
    pickupLabelsMayOverlap(left.labels, right.labels)
  );
}

function intersects(left: string[], right: string[]): boolean {
  return (
    left.length === 0 ||
    right.length === 0 ||
    left.some((value) => right.includes(value))
  );
}

function normalizeStates(
  value: OrchestratorTrackerSettingValue | undefined
): string[] {
  if (typeof value !== "string") return [];
  return value
    .split("\n")
    .map((state) => state.trim().toLowerCase())
    .filter(Boolean);
}

function normalizePickupLabels(
  value: OrchestratorTrackerSettingValue | undefined
): PickupLabels {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    return { include: [], exclude: [] };
  }
  const labels = value as Record<string, OrchestratorTrackerSettingValue>;
  return {
    include: normalizeLabelList(labels.include),
    exclude: normalizeLabelList(labels.exclude),
  };
}

function normalizeLabelList(
  value: OrchestratorTrackerSettingValue | undefined
): string[] {
  if (!Array.isArray(value)) return [];
  return normalizeLabels(value);
}

/** Returns false only when the two label predicates are provably disjoint. */
function pickupLabelsMayOverlap(
  left: PickupLabels,
  right: PickupLabels
): boolean {
  const leftCandidates = left.include.length > 0 ? left.include : [undefined];
  const rightCandidates =
    right.include.length > 0 ? right.include : [undefined];
  return leftCandidates.some(
    (leftLabel) =>
      !right.exclude.includes(leftLabel ?? "") &&
      rightCandidates.some(
        (rightLabel) => !left.exclude.includes(rightLabel ?? "")
      )
  );
}

function trackerSettings(
  workflow: ReturnType<typeof parseWorkflowMarkdown>,
  repository: RepositoryRef
): Record<string, OrchestratorTrackerSettingValue> {
  return {
    ...(workflow.tracker.projectId
      ? { projectId: workflow.tracker.projectId }
      : {}),
    ...(workflow.tracker.projectSlug
      ? { projectSlug: workflow.tracker.projectSlug }
      : {}),
    ...(workflow.tracker.kind === "linear"
      ? {
          activeStates: workflow.tracker.activeStates.join("\n"),
          terminalStates: workflow.tracker.terminalStates.join("\n"),
        }
      : {}),
    blockerCheckStates: workflow.tracker.blockerCheckStates.join("\n"),
    ...(workflow.tracker.pickupLabels.include.length > 0 ||
    workflow.tracker.pickupLabels.exclude.length > 0
      ? { pickupLabels: workflow.tracker.pickupLabels }
      : {}),
    repository: `${repository.owner}/${repository.name}`,
    ...(workflow.tracker.kind === "file" &&
    process.env.GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH
      ? // E2E-only escape hatch, mirroring the repo-embedded runtime.
        { issuesPath: process.env.GH_SYMPHONY_FILE_TRACKER_ISSUES_PATH }
      : {}),
  };
}

function parseRepository(value: Record<string, unknown> | null): RepositoryRef {
  const spec =
    typeof value?.slug === "string"
      ? value.slug
      : typeof value?.repository === "string"
        ? value.repository
        : null;
  const [owner, name] = spec?.split("/") ?? [];
  if (!owner || !name || name.includes("/")) {
    throw new Error(
      'WORKFLOW.md repository extension requires "slug: owner/name". Repositories that embed their own workflow are started with "gh-symphony repo start".'
    );
  }
  // `clone_url` lets a project point at a mirror, a GHES host, or a local path
  // while keeping owner/name as the tracker and cache identity.
  const cloneUrl =
    typeof value?.clone_url === "string" && value.clone_url
      ? value.clone_url
      : typeof value?.cloneUrl === "string" && value.cloneUrl
        ? value.cloneUrl
        : `https://github.com/${owner}/${name}.git`;
  return { owner, name, cloneUrl };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const USAGE =
  "Usage: gh-symphony project <list|start|status|stop> [--project-dir <path>] [runtime options]\n";

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => {
  const [subcommand, ...rest] = args;

  if (subcommand === "list" && rest.length === 0) {
    const instances = new Map(
      (await listInstances())
        .filter((entry) => entry.standalone)
        .map((entry) => [entry.projectId, entry])
    );
    // Preserve the established cached-project schema. Live registry data is
    // additive so stopped projects remain visible and JSON consumers have a
    // stable base shape.
    const projects = (await listStandaloneProjects(options.configDir)).map(
      (project) => {
        const instance = instances.get(project.projectId);
        return instance ? { ...project, instance } : project;
      }
    );
    process.stdout.write(JSON.stringify(projects, null, 2) + "\n");
    return;
  }

  if (
    subcommand === "start" ||
    subcommand === "status" ||
    subcommand === "stop"
  ) {
    const { projectDir, forwarded, error } = extractProjectDir(rest);
    if (error) {
      process.stderr.write(`${error}\n${USAGE}`);
      process.exitCode = 2;
      return;
    }

    const resolvedProjectDir = resolve(projectDir ?? process.cwd());
    if (subcommand === "start") {
      // Re-derive on every start so an edited WORKFLOW.md takes effect without
      // a separate registration step.
      const project = await deriveStandaloneProject(
        resolvedProjectDir,
        options
      );
      await startCommand(forwarded, {
        ...options,
        invocation: "project",
        projectId: project.projectId,
      });
      return;
    }

    // Status and stop only need to address the runtime, which the folder path
    // identifies on its own — a removed or broken WORKFLOW.md must not block
    // stopping a running daemon.
    const projectId = standaloneProjectId(resolvedProjectDir);
    const project = await loadProjectConfig(options.configDir, projectId);
    if (!project) {
      const known = await listStandaloneProjects(options.configDir);
      process.stderr.write(
        `No standalone project runtime for ${resolvedProjectDir}.\n` +
          (known.length > 0
            ? `Started projects: ${known.map((entry) => entry.projectDir ?? entry.projectId).join(", ")}\n`
            : "Run 'gh-symphony project start' from a project folder first.\n")
      );
      process.exitCode = 1;
      return;
    }

    const runtimeOptions = {
      ...options,
      invocation: "project" as const,
      projectId,
    };
    if (subcommand === "status") {
      await statusCommand(forwarded, runtimeOptions);
      return;
    }
    await stopCommand(forwarded, runtimeOptions);
    return;
  }

  process.stderr.write(USAGE);
  process.exitCode = 2;
};

export default handler;
