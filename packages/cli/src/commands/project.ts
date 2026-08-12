import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import * as p from "@clack/prompts";
import {
  parseWorkflowMarkdown,
  type OrchestratorTrackerSettingValue,
  type RepositoryRef,
} from "@gh-symphony/core";
import type { GlobalOptions } from "../index.js";
import startCommand from "./start.js";
import statusCommand from "./status.js";
import stopCommand from "./stop.js";
import {
  loadGlobalConfig,
  loadProjectConfig,
  saveGlobalConfig,
  saveProjectConfig,
  type CliProjectConfig,
} from "../config.js";

type PickupLabels = { include: string[]; exclude: string[] };

type Mapping = {
  adapter: string;
  bindingId: string;
  states: string[];
  labels: PickupLabels;
};

export async function registerStandaloneProject(
  projectDirInput: string,
  options: Pick<GlobalOptions, "configDir">
): Promise<CliProjectConfig> {
  const projectDir = resolve(projectDirInput);
  const workflowPath = resolve(projectDir, "WORKFLOW.md");
  const workflow = parseWorkflowMarkdown(await readFile(workflowPath, "utf8"));
  const repository = parseRepository(workflow.repository);
  const adapter = workflow.tracker.kind ?? "github-project";
  const bindingId =
    workflow.tracker.projectId ?? workflow.tracker.projectSlug ?? "";
  if (!bindingId) {
    throw new Error(
      "WORKFLOW.md tracker configuration requires project_id or project_slug."
    );
  }
  const projectId = projectIdentifier(projectDir);
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

  const overlap = await findOverlappingProjects(options.configDir, config);
  if (overlap.length > 0 && !process.stdin.isTTY) {
    throw new Error(
      `Tracker mapping overlaps registered project(s): ${overlap.join(", ")}. Re-run interactively to confirm.`
    );
  }
  if (overlap.length > 0) {
    const confirmed = await p.confirm({
      message: `Tracker mapping overlaps registered project(s): ${overlap.join(", ")}. Register anyway?`,
      initialValue: false,
    });
    if (p.isCancel(confirmed) || !confirmed) {
      throw new Error(
        "Standalone project registration cancelled because tracker mappings overlap."
      );
    }
  }

  await saveProjectConfig(options.configDir, projectId, config);
  const global = await loadGlobalConfig(options.configDir);
  await saveGlobalConfig(options.configDir, {
    activeProject: projectId,
    projects: [...new Set([...(global?.projects ?? []), projectId])],
  });
  return config;
}

async function findOverlappingProjects(
  configDir: string,
  candidate: CliProjectConfig
): Promise<string[]> {
  const global = await loadGlobalConfig(configDir);
  const candidateMapping = mappingFor(candidate);
  const overlaps: string[] = [];
  for (const id of global?.projects ?? []) {
    const existing = await loadProjectConfig(configDir, id);
    if (!existing || existing.projectId === candidate.projectId) continue;
    if (
      existing.repository?.owner !== candidate.repository?.owner ||
      existing.repository?.name !== candidate.repository?.name
    )
      continue;
    if (mappingsOverlap(candidateMapping, mappingFor(existing)))
      overlaps.push(id);
  }
  return overlaps;
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
  return value.filter((label): label is string => typeof label === "string");
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
      ? { activeStates: workflow.tracker.activeStates.join("\n") }
      : {}),
    ...(workflow.tracker.pickupLabels.include.length > 0 ||
    workflow.tracker.pickupLabels.exclude.length > 0
      ? { pickupLabels: workflow.tracker.pickupLabels }
      : {}),
    repository: `${repository.owner}/${repository.name}`,
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
      'WORKFLOW.md repository extension requires "slug: owner/name".'
    );
  }
  return { owner, name, cloneUrl: `https://github.com/${owner}/${name}.git` };
}

function projectIdentifier(projectDir: string): string {
  return `${slugify(basename(projectDir)) || "project"}-${createHash("sha256").update(projectDir).digest("hex").slice(0, 8)}`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => {
  const [subcommand, projectDir] = args;
  if (subcommand === "add" && projectDir && args.length === 2) {
    const project = await registerStandaloneProject(projectDir, options);
    process.stdout.write(
      `Standalone project registered: ${project.projectId}\n`
    );
    return;
  }
  if (subcommand === "list" && args.length === 1) {
    const global = await loadGlobalConfig(options.configDir);
    const projects = await Promise.all(
      (global?.projects ?? []).map((id) =>
        loadProjectConfig(options.configDir, id)
      )
    );
    process.stdout.write(
      JSON.stringify(projects.filter(Boolean), null, 2) + "\n"
    );
    return;
  }
  if (subcommand === "start") {
    await startCommand(args.slice(1), { ...options, invocation: "project" });
    return;
  }
  if (subcommand === "status") {
    await statusCommand(args.slice(1), options);
    return;
  }
  if (subcommand === "stop") {
    await stopCommand(args.slice(1), options);
    return;
  }
  process.stderr.write(
    "Usage: gh-symphony project <add <projectDir>|list|start|status|stop>\n"
  );
  process.exitCode = 2;
};

export default handler;
