import * as p from "@clack/prompts";
import {
  formatClaudePreflightText,
  resolveClaudeCommandBinary,
  runClaudePreflight,
} from "@gh-symphony/runtime-claude";
import type {
  WorkflowLifecycleConfig,
  WorkflowPriorityConfig,
} from "@gh-symphony/core";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { GlobalOptions } from "../index.js";
import {
  createClient,
  validateToken,
  checkRequiredScopes,
  discoverUserProjects,
  listUserProjects,
  listRepositoryLabels,
  getProjectDetail,
  GitHubScopeError,
  type GitHubClient,
  type ProjectDiscoveryResult,
  type ProjectSummary,
  type ProjectDetail,
  type ProjectStatusField,
  type LinkedRepository,
} from "../github/client.js";
import {
  inferAllStateRoles,
  toWorkflowLifecycleConfig,
  validateStateMapping,
} from "../mapping/smart-defaults.js";
import { generateWorkflowMarkdown } from "../workflow/generate-workflow-md.js";
import {
  loadGlobalConfig,
  saveGlobalConfig,
  saveProjectConfig,
  type CliGlobalConfig,
  type StateRole,
  type StateMapping,
} from "../config.js";
import { getGhTokenWithSource, GhAuthError } from "../github/gh-auth.js";
import { resolveGitHubAuth } from "../github/gh-auth.js";
import { detectEnvironment } from "../detection/environment-detector.js";
import type { DetectedEnvironment } from "../detection/environment-detector.js";
import {
  DEFAULT_AFTER_CREATE_HOOK_CONTENT,
  DEFAULT_AFTER_CREATE_HOOK_LABEL,
  DEFAULT_AFTER_CREATE_HOOK_PATH,
} from "../workflow/default-hooks.js";
import {
  buildSkillFilePlans,
  resolveSkillsDir,
} from "../skills/skill-writer.js";
import { ALL_SKILL_TEMPLATES } from "../skills/templates/index.js";
import {
  isClaudeRuntime,
  normalizeInitRuntime,
  resolveRuntimeCommand,
  isSupportedInitRuntime,
  type InitRuntimeKind,
} from "../workflow/workflow-runtime.js";

// ── Scope error display ───────────────────────────────────────────────────────

const KNOWN_REQUIRED_SCOPES = ["repo", "read:org", "project"] as const;

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

export function warnIfProjectDiscoveryPartial(
  result: Pick<
    ProjectDiscoveryResult,
    "partial" | "reason" | "projects" | "requests"
  >
): void {
  if (!result.partial) {
    return;
  }

  const limitDetail =
    result.reason === "result_limit"
      ? "the discovered project count reached the safety cap"
      : "the GitHub API request budget reached the safety cap";

  p.log.warn(
    `Project discovery may be incomplete: ${limitDetail}. Showing ${result.projects.length} discovered project${result.projects.length === 1 ? "" : "s"} after ${result.requests} request${result.requests === 1 ? "" : "s"}.`
  );
}

// ── Cancellation utility ─────────────────────────────────────────────────────

export async function abortIfCancelled<T>(
  input: T | Promise<T>
): Promise<Exclude<T, symbol>> {
  const result = await input;
  if (p.isCancel(result)) {
    p.cancel("Setup cancelled.");
    process.exit(130);
  }
  return result as Exclude<T, symbol>;
}

// ── Non-interactive flag parsing ─────────────────────────────────────────────

type InitFlags = {
  dryRun: boolean;
  nonInteractive: boolean;
  project?: string;
  output?: string;
  runtime?: string;
  skipSkills: boolean;
  skipContext: boolean;
};

const SKIP_CONTEXT_DEPRECATION =
  "--skip-context is deprecated and is now a no-op. Repo-local .gh-symphony/context.yaml is no longer generated.";

const LEGACY_GH_SYMPHONY_FILES = [
  {
    relativePath: ".gh-symphony/context.yaml",
    reason: "replaced by skill-local references/",
  },
  {
    relativePath: ".gh-symphony/reference-workflow.md",
    reason: null,
  },
] as const;

function parseInitFlags(args: string[]): InitFlags {
  const flags: InitFlags = {
    dryRun: false,
    nonInteractive: false,
    runtime: "codex",
    skipSkills: false,
    skipContext: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = args[i + 1];
    switch (arg) {
      case "--dry-run":
        flags.dryRun = true;
        break;
      case "--non-interactive":
        flags.nonInteractive = true;
        break;
      case "--project":
        flags.project = next;
        i += 1;
        break;
      case "--output":
        flags.output = next;
        i += 1;
        break;
      case "--runtime":
        flags.runtime = next ?? "";
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

export function warnDeprecatedSkipContext(): void {
  p.log.warn(SKIP_CONTEXT_DEPRECATION);
}

async function runInitRuntimePreflight(runtime: string): Promise<boolean> {
  if (!isClaudeRuntime(runtime)) {
    return true;
  }

  const hasGitHubGraphqlToken =
    typeof process.env.GITHUB_GRAPHQL_TOKEN === "string" &&
    process.env.GITHUB_GRAPHQL_TOKEN.trim().length > 0;
  const report = await runClaudePreflight({
    cwd: process.cwd(),
    env: process.env,
    command:
      resolveClaudeCommandBinary(resolveRuntimeCommand(runtime)) ??
      resolveRuntimeCommand(runtime),
    authMode: "local-or-api-key",
    includeGhAuth: !hasGitHubGraphqlToken,
  });
  const message = formatClaudePreflightText(report);
  if (report.ok) {
    p.log.info(message);
    return true;
  }

  p.log.error(message);
  return false;
}

// ── Init command handler ─────────────────────────────────────────────────────

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => {
  const flags = parseInitFlags(args);
  if (flags.skipContext) {
    warnDeprecatedSkipContext();
  }

  if (flags.nonInteractive) {
    await runNonInteractive(flags, options);
    return;
  }

  await runInteractive(flags, options);
};

export default handler;

// ── Runtime selection and preflight ─────────────────────────────────────────

function resolveInitRuntime(runtime: string | undefined): string {
  return normalizeInitRuntime(runtime ?? "codex-app-server");
}

function validateInitRuntime(runtime: string): string | null {
  if (isSupportedInitRuntime(runtime)) {
    return null;
  }
  return `Unsupported runtime '${runtime}'. Choose one of: codex-app-server, claude-print.`;
}

async function promptRuntimeSelection(): Promise<InitRuntimeKind> {
  return abortIfCancelled(
    p.select({
      message: "Step 1/5 — Select the agent runtime:",
      options: [
        {
          value: "codex-app-server",
          label: "codex-app-server",
          hint: "Codex app-server JSON-RPC runtime",
        },
        {
          value: "claude-print",
          label: "claude-print",
          hint: "Claude Code non-interactive stream-json runtime",
        },
      ],
    })
  );
}

function commandRuns(binary: string, args: string[]): boolean {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 3000,
  });
  return result.error === undefined && result.status === 0;
}

function runRuntimePreflight(runtime: string): void {
  const command = resolveRuntimeCommand(runtime);
  const checks: Array<{ label: string; ok: boolean; detail: string }> = [];
  const versionOk = commandRuns(command, ["--version"]);
  checks.push({
    label: "Runtime binary",
    ok: versionOk,
    detail: versionOk
      ? `${command} is available on PATH.`
      : `${command} was not found or did not run with --version.`,
  });

  if (isClaudeRuntime(runtime)) {
    const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY);
    checks.push({
      label: "Claude auth",
      ok: hasAnthropicKey,
      detail: hasAnthropicKey
        ? "ANTHROPIC_API_KEY is set."
        : "ANTHROPIC_API_KEY is not set. Set it before running Claude workers.",
    });
  }

  const okIcon = "OK";
  const failIcon = "FAIL";
  const lines = checks.map(
    (check) =>
      `${check.ok ? okIcon : failIcon} ${check.label.padEnd(16)} ${check.detail}`
  );
  p.note(lines.join("\n"), `Runtime preflight — ${runtime}`);

  if (checks.some((check) => !check.ok)) {
    p.log.warn(
      "Runtime preflight found missing local prerequisites. Generated files still include the selected runtime defaults."
    );
  }
}

// ── Ecosystem file generation ────────────────────────────────────────────────

type EcosystemOptions = {
  cwd: string;
  projectDetail: ProjectDetail;
  statusField: ProjectStatusField;
  priorityField: ProjectStatusField | null;
  priority?: WorkflowPriorityConfig;
  includePriorityTemplates?: boolean;
  runtime: string;
  skipSkills: boolean;
  skipContext: boolean;
  environment?: DetectedEnvironment;
  lifecycle?: WorkflowLifecycleConfig;
};

export type EcosystemResult = {
  projectId: string;
  githubProjectTitle: string;
  runtime: string;
  priority: WorkflowPriorityConfig;
  lifecycle: WorkflowLifecycleConfig;
  waitStates: string[];
  skillsDir: string | null;
  skipSkills: boolean;
  afterCreateHookWritten: boolean;
  contextYamlWritten: boolean;
  referenceWorkflowWritten: boolean;
  skillsWritten: string[];
  skillsSkipped: string[];
  legacyFilesRemoved: string[];
};

type PlannedWriteMode = "overwrite" | "create-only";
type PlannedChangeStatus = "create" | "update" | "unchanged";

export type PlannedFileChange = {
  path: string;
  label: string;
  content: string;
  mode: PlannedWriteMode;
  status: PlannedChangeStatus;
  executable?: boolean;
};

export type EcosystemPlan = {
  projectId: string;
  githubProjectTitle: string;
  runtime: string;
  priority: WorkflowPriorityConfig;
  lifecycle: WorkflowLifecycleConfig;
  waitStates: string[];
  skillsDir: string | null;
  skipSkills: boolean;
  environment: Awaited<ReturnType<typeof detectEnvironment>>;
  files: PlannedFileChange[];
};

export type DryRunJsonResult = {
  dryRun: true;
  output: string;
  projectId: string;
  githubProjectTitle: string;
  runtime: string;
  priority: WorkflowPriorityConfig;
  files: Array<{
    path: string;
    label: string;
    status: PlannedChangeStatus;
    mode: PlannedWriteMode;
  }>;
  environment: Awaited<ReturnType<typeof detectEnvironment>>;
};

export type WorkflowArtifactsOptions = {
  cwd: string;
  outputPath: string;
  projectDetail: ProjectDetail;
  statusField: ProjectStatusField;
  priorityField: ProjectStatusField | null;
  priority?: WorkflowPriorityConfig;
  includePriorityTemplates?: boolean;
  mappings: Record<string, StateMapping>;
  lifecycle?: WorkflowLifecycleConfig;
  runtime: string;
  skipSkills: boolean;
  skipContext: boolean;
  environment?: DetectedEnvironment;
};

export type WorkflowArtifactsPlan = {
  outputPath: string;
  workflowMd: string;
  workflowPlan: PlannedFileChange;
  ecosystemPlan: EcosystemPlan;
};

export async function findLegacyGhSymphonyFiles(
  cwd: string
): Promise<string[]> {
  const found: string[] = [];
  for (const legacyFile of LEGACY_GH_SYMPHONY_FILES) {
    try {
      await readFile(join(cwd, legacyFile.relativePath), "utf8");
      found.push(legacyFile.relativePath);
    } catch {
      // Missing or unreadable legacy files are ignored; generation no longer
      // depends on them.
    }
  }
  return found;
}

export async function removeLegacyGhSymphonyFiles(
  cwd: string,
  legacyFiles: string[]
): Promise<string[]> {
  const removed: string[] = [];

  for (const relativePath of legacyFiles) {
    await rm(join(cwd, relativePath), { force: true });
    removed.push(relativePath);
  }

  const legacyDir = join(cwd, ".gh-symphony");
  try {
    const remaining = await readdir(legacyDir);
    if (remaining.length === 0) {
      await rmdir(legacyDir);
    }
  } catch {
    // Directory already absent or not readable; cleanup is best-effort.
  }

  return removed;
}

export async function promptLegacyGhSymphonyCleanup(
  cwd: string
): Promise<string[]> {
  const legacyFiles = await findLegacyGhSymphonyFiles(cwd);
  if (legacyFiles.length === 0) {
    return [];
  }

  const lines = [
    "Found legacy .gh-symphony/ directory.",
    "These files are no longer used:",
  ];
  for (const legacyFile of LEGACY_GH_SYMPHONY_FILES) {
    if (!legacyFiles.includes(legacyFile.relativePath)) {
      continue;
    }
    const suffix = legacyFile.reason ? ` (${legacyFile.reason})` : "";
    lines.push(`  • ${legacyFile.relativePath}${suffix}`);
  }
  lines.push("Safe to delete.");
  p.log.info(lines.join("\n"));

  const removeFiles = await abortIfCancelled(
    p.confirm({
      message: "Remove legacy .gh-symphony/ files?",
      initialValue: false,
    })
  );
  if (!removeFiles) {
    return [];
  }

  return removeLegacyGhSymphonyFiles(cwd, legacyFiles);
}

async function resolveChangeStatus(
  path: string,
  content: string,
  mode: PlannedWriteMode
): Promise<PlannedChangeStatus> {
  try {
    const existing = await readFile(path, "utf8");
    if (mode === "create-only") {
      return "unchanged";
    }
    return existing === content ? "unchanged" : "update";
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return "create";
    }
    throw error;
  }
}

async function planFileChange(input: {
  path: string;
  label: string;
  content: string;
  mode: PlannedWriteMode;
  executable?: boolean;
}): Promise<PlannedFileChange> {
  return {
    ...input,
    status: await resolveChangeStatus(input.path, input.content, input.mode),
  };
}

async function writePlannedFile(file: PlannedFileChange): Promise<boolean> {
  if (file.status === "unchanged") {
    return false;
  }

  await mkdir(dirname(file.path), { recursive: true });
  const temporaryPath = `${file.path}.tmp`;
  await writeFile(temporaryPath, file.content, "utf8");
  await rename(temporaryPath, file.path);
  if (file.executable) {
    await chmod(file.path, 0o755);
  }
  return true;
}

function skillNameForPath(skillsDir: string, filePath: string): string {
  return relative(skillsDir, filePath).split(/[\\/]/)[0] ?? "";
}

export function resolveStatusField(
  projectDetail: ProjectDetail
): ProjectStatusField | null {
  return (
    projectDetail.statusFields.find((f) => f.name.toLowerCase() === "status") ??
    projectDetail.statusFields[0] ??
    null
  );
}

export function buildAutomaticStateMappings(
  statusField: ProjectStatusField
): Record<string, StateMapping> {
  const mappings: Record<string, StateMapping> = {};
  for (const mapping of inferAllStateRoles(
    statusField.options.map((o) => o.name)
  )) {
    if (mapping.role) {
      mappings[mapping.columnName] = { role: mapping.role };
    }
  }
  return mappings;
}

function isPriorityFieldCandidateName(fieldName: string): boolean {
  return /\bpriority\b/i.test(fieldName.trim());
}

export function resolvePriorityField(
  projectDetail: ProjectDetail,
  statusField: ProjectStatusField
): {
  field: ProjectStatusField | null;
  ambiguous: ProjectStatusField[];
} {
  const singleSelectFields = projectDetail.statusFields.filter(
    (field) => field.id !== statusField.id
  );

  const exactMatches = singleSelectFields.filter(
    (field) => field.name.trim().toLowerCase() === "priority"
  );
  if (exactMatches.length === 1) {
    return { field: exactMatches[0]!, ambiguous: [] };
  }
  if (exactMatches.length > 1) {
    return { field: null, ambiguous: exactMatches };
  }

  const likelyMatches = singleSelectFields.filter((field) =>
    isPriorityFieldCandidateName(field.name)
  );
  if (likelyMatches.length === 1) {
    return { field: likelyMatches[0]!, ambiguous: [] };
  }
  if (likelyMatches.length > 1) {
    return { field: null, ambiguous: likelyMatches };
  }

  return { field: null, ambiguous: [] };
}

function buildProjectFieldPriority(
  field: ProjectStatusField
): WorkflowPriorityConfig {
  return {
    source: "project-field",
    field: field.name,
    values: Object.fromEntries(
      field.options.map((option, index) => [option.name, index])
    ),
  };
}

function buildDisabledPriority(): WorkflowPriorityConfig {
  return { source: "disabled" };
}

export async function collectPriorityLabelNames(
  client: GitHubClient,
  repositories: LinkedRepository[]
): Promise<string[]> {
  const labels = new Set<string>();
  for (const repository of repositories) {
    try {
      const repoLabels = await listRepositoryLabels(
        client,
        repository.owner,
        repository.name
      );
      for (const label of repoLabels) {
        labels.add(label.name);
      }
    } catch {
      // Label priority is optional setup data. If labels cannot be listed,
      // the operator can still choose project-field or disabled.
    }
  }
  return [...labels].sort((a, b) => a.localeCompare(b));
}

async function promptPriorityField(
  priorityCandidates: ProjectStatusField[],
  options?: {
    stepLabel?: string;
  }
): Promise<ProjectStatusField | null> {
  if (priorityCandidates.length === 0) {
    return null;
  }

  const selectedFieldId = await abortIfCancelled(
    p.select({
      message: `${options?.stepLabel ?? "Priority field"} — Multiple GitHub Project priority fields look plausible. Select the one Symphony should use:`,
      options: [
        ...priorityCandidates.map((field) => ({
          value: field.id,
          label: field.name,
          hint: `${field.options.length} option${field.options.length === 1 ? "" : "s"}`,
        })),
        {
          value: "__skip_priority_field__",
          label: "Skip priority-aware dispatch",
          hint: "Write source: disabled",
        },
      ],
    })
  );

  if (selectedFieldId === "__skip_priority_field__") {
    return null;
  }

  return (
    priorityCandidates.find((field) => field.id === selectedFieldId) ?? null
  );
}

async function promptProjectFieldPriorityValues(
  field: ProjectStatusField
): Promise<Record<string, number>> {
  const values: Record<string, number> = {};
  for (const [index, option] of field.options.entries()) {
    const rawValue = await abortIfCancelled(
      p.text({
        message: `Priority value for option "${option.name}"`,
        placeholder: String(index),
        initialValue: String(index),
        validate: validatePriorityInteger,
      })
    );
    values[option.name] = Number(rawValue);
  }
  return values;
}

export async function promptPriorityConfig(input: {
  priorityResolution: ReturnType<typeof resolvePriorityField>;
  labelNames: string[];
  stepLabel?: string;
}): Promise<{
  priority: WorkflowPriorityConfig;
  priorityField: ProjectStatusField | null;
}> {
  const hasProjectField =
    Boolean(input.priorityResolution.field) ||
    input.priorityResolution.ambiguous.length > 0;
  const hasLabels = input.labelNames.length > 0;
  const selectedSource = await abortIfCancelled(
    p.select({
      message: `${input.stepLabel ?? "Priority"} — Choose one priority source:`,
      options: [
        ...(hasProjectField
          ? [
              {
                value: "project-field",
                label: "GitHub Project field",
                hint: "Map single-select options to explicit numbers",
              },
            ]
          : []),
        ...(hasLabels
          ? [
              {
                value: "labels",
                label: "GitHub labels",
                hint: "Map existing repository labels to explicit numbers",
              },
            ]
          : []),
        {
          value: "disabled",
          label: "Disabled",
          hint: "Write source: disabled",
        },
      ],
    })
  );

  if (selectedSource === "disabled") {
    return { priority: buildDisabledPriority(), priorityField: null };
  }

  if (selectedSource === "labels") {
    const selectedLabels = await abortIfCancelled(
      p.multiselect({
        message: "Select priority labels to map:",
        options: input.labelNames.map((label) => ({
          value: label,
          label,
        })),
        required: true,
      })
    );
    const labels: Record<string, number> = {};
    for (const [index, label] of selectedLabels.entries()) {
      const rawValue = await abortIfCancelled(
        p.text({
          message: `Priority value for label "${label}"`,
          placeholder: String(index),
          initialValue: String(index),
          validate: validatePriorityInteger,
        })
      );
      labels[label] = Number(rawValue);
    }
    return { priority: { source: "labels", labels }, priorityField: null };
  }

  const priorityField =
    input.priorityResolution.ambiguous.length > 0
      ? await promptPriorityField(input.priorityResolution.ambiguous, {
          stepLabel: "Priority field",
        })
      : input.priorityResolution.field;

  if (!priorityField) {
    return { priority: buildDisabledPriority(), priorityField: null };
  }

  return {
    priority: {
      source: "project-field",
      field: priorityField.name,
      values: await promptProjectFieldPriorityValues(priorityField),
    },
    priorityField,
  };
}

function validatePriorityInteger(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed !== "" && Number.isInteger(Number(trimmed))
    ? undefined
    : "Enter an integer.";
}

export async function promptStateMappings(
  statusField: ProjectStatusField,
  options?: {
    stepLabel?: string;
  }
): Promise<Record<string, StateMapping>> {
  const mappings: Record<string, StateMapping> = {};
  const inferred = inferAllStateRoles(statusField.options.map((o) => o.name));

  p.log.info(
    `Found ${statusField.options.length} status columns on field "${statusField.name}".`
  );

  for (const mapping of inferred) {
    const roleOptions: Array<{ value: StateRole; label: string }> = [
      { value: "active", label: "Active (agent works on this)" },
      { value: "wait", label: "Wait (human review / hold)" },
      { value: "terminal", label: "Terminal (completed)" },
    ];

    const defaultRole = mapping.role ?? "wait";
    const sortedOptions = [
      roleOptions.find((o) => o.value === defaultRole)!,
      ...roleOptions.filter((o) => o.value !== defaultRole),
    ];

    const selectedRole = await abortIfCancelled(
      p.select({
        message: `${options?.stepLabel ?? "Step 2/2"} — Map column "${mapping.columnName}":${mapping.confidence === "high" ? " (auto-detected)" : ""}`,
        options: sortedOptions,
      })
    );

    mappings[mapping.columnName] = { role: selectedRole };
  }

  return mappings;
}

export function getDefaultBlockerCheckStates(
  lifecycle: Pick<WorkflowLifecycleConfig, "activeStates">
): string[] {
  const firstActive = lifecycle.activeStates[0];
  return firstActive ? [firstActive] : [];
}

export async function promptBlockerCheck(
  lifecycle: Pick<WorkflowLifecycleConfig, "activeStates">,
  options?: {
    stepLabel?: string;
  }
): Promise<string[]> {
  const stepLabel = options?.stepLabel ?? "Step 3/5";
  const activeStates = lifecycle.activeStates;
  const defaultStates = getDefaultBlockerCheckStates(lifecycle);

  if (activeStates.length === 0) {
    p.log.warn("No active states; blocker check cannot be enabled.");
    p.log.info("Blocker check: disabled");
    return [];
  }

  const activeStateSummary =
    activeStates.length === 1
      ? `"${activeStates[0]}"`
      : "selected active states";

  const enabled = await abortIfCancelled(
    p.confirm({
      message: `${stepLabel} — Enable blocker check? Issues with unresolved "blocked by" dependencies will be held back from dispatch on ${activeStateSummary}.`,
      initialValue: true,
    })
  );

  if (!enabled) {
    p.log.info("Blocker check: disabled");
    return [];
  }

  if (activeStates.length === 1) {
    p.log.info(`Blocker check applies to: ${activeStates[0]}`);
    return [activeStates[0]!];
  }

  const selectedStates = await abortIfCancelled(
    p.multiselect({
      message: `${stepLabel} — Which active states should be blocker-checked?`,
      options: activeStates.map((state) => ({
        value: state,
        label: state,
        hint: defaultStates.includes(state) ? "default" : undefined,
      })),
      initialValues: defaultStates,
      required: true,
    })
  );

  p.log.info(`Blocker check applies to: ${selectedStates.join(", ")}`);
  return [...selectedStates];
}

export async function planWorkflowArtifacts(
  opts: WorkflowArtifactsOptions
): Promise<WorkflowArtifactsPlan> {
  const environment = opts.environment ?? (await detectEnvironment(opts.cwd));
  const priority =
    opts.priority ??
    (opts.priorityField
      ? buildProjectFieldPriority(opts.priorityField)
      : buildDisabledPriority());
  const defaultLifecycle = toWorkflowLifecycleConfig(
    opts.statusField.name,
    opts.mappings
  );
  const defaultBlockerCheckStates =
    getDefaultBlockerCheckStates(defaultLifecycle);
  const lifecycle =
    opts.lifecycle ??
    toWorkflowLifecycleConfig(opts.statusField.name, opts.mappings, {
      blockerCheckStates: defaultBlockerCheckStates,
      planningStates: defaultBlockerCheckStates,
    });
  const workflowMd = generateWorkflowMarkdown({
    projectId: opts.projectDetail.id,
    stateFieldName: opts.statusField.name,
    priority,
    includePriorityTemplates:
      opts.includePriorityTemplates ?? priority.source === "disabled",
    mappings: opts.mappings,
    lifecycle,
    runtime: opts.runtime,
    detectedEnvironment: environment,
  });

  const workflowPlan = await planFileChange({
    path: opts.outputPath,
    label: "WORKFLOW.md",
    content: workflowMd,
    mode: "overwrite",
  });
  const ecosystemPlan = await planEcosystem({
    cwd: opts.cwd,
    projectDetail: opts.projectDetail,
    statusField: opts.statusField,
    priorityField: opts.priorityField,
    priority,
    lifecycle,
    includePriorityTemplates:
      opts.includePriorityTemplates ?? priority.source === "disabled",
    runtime: opts.runtime,
    skipSkills: opts.skipSkills,
    skipContext: opts.skipContext,
    environment,
  });

  return {
    outputPath: opts.outputPath,
    workflowMd,
    workflowPlan,
    ecosystemPlan,
  };
}

export async function writeWorkflowPlan(
  workflowPlan: PlannedFileChange
): Promise<boolean> {
  return writePlannedFile(workflowPlan);
}

function summarizeEnvironment(
  env: Awaited<ReturnType<typeof detectEnvironment>>
): string[] {
  return [
    `Package manager   ${env.packageManager ?? "none"}${env.lockfile ? ` (${env.lockfile})` : ""}`,
    `Scripts   test=${env.testCommand ?? "none"} | lint=${env.lintCommand ?? "none"} | build=${env.buildCommand ?? "none"}`,
    `CI   ${env.ciPlatform ?? "none"}`,
    `Monorepo   ${env.monorepo ? "yes" : "no"}`,
    `Existing skills   ${env.existingSkills.length === 0 ? "none" : env.existingSkills.join(", ")}`,
  ];
}

function deriveWaitStates(
  statusField: ProjectStatusField,
  lifecycle: WorkflowLifecycleConfig
): string[] {
  const active = new Set(lifecycle.activeStates);
  const terminal = new Set(lifecycle.terminalStates);
  return statusField.options
    .map((option) => option.name)
    .filter((state) => !active.has(state) && !terminal.has(state));
}

export async function planEcosystem(
  opts: EcosystemOptions
): Promise<EcosystemPlan> {
  const {
    cwd,
    projectDetail,
    statusField,
    priorityField,
    runtime,
    skipSkills,
  } = opts;
  const priority =
    opts.priority ??
    (priorityField
      ? buildProjectFieldPriority(priorityField)
      : buildDisabledPriority());
  const automaticLifecycle = toWorkflowLifecycleConfig(
    statusField.name,
    buildAutomaticStateMappings(statusField)
  );
  const defaultBlockerCheckStates =
    getDefaultBlockerCheckStates(automaticLifecycle);
  const lifecycle =
    opts.lifecycle ??
    toWorkflowLifecycleConfig(
      statusField.name,
      buildAutomaticStateMappings(statusField),
      {
        blockerCheckStates: defaultBlockerCheckStates,
        planningStates: defaultBlockerCheckStates,
      }
    );
  const environment = opts.environment ?? (await detectEnvironment(cwd));
  const files: PlannedFileChange[] = [];

  files.push(
    await planFileChange({
      path: join(cwd, DEFAULT_AFTER_CREATE_HOOK_PATH),
      label: DEFAULT_AFTER_CREATE_HOOK_LABEL,
      content: DEFAULT_AFTER_CREATE_HOOK_CONTENT,
      mode: "create-only",
      executable: true,
    })
  );

  const skillsDir = skipSkills ? null : resolveSkillsDir(cwd, runtime);
  if (!skipSkills && skillsDir) {
    const { files: plannedSkills } = buildSkillFilePlans(
      cwd,
      runtime,
      ALL_SKILL_TEMPLATES,
      {
        runtime,
        projectId: projectDetail.id,
        githubProjectTitle: projectDetail.title,
        repositories: projectDetail.linkedRepositories.map((r) => ({
          owner: r.owner,
          name: r.name,
        })),
        statusColumns: statusField.options.map((o) => ({
          id: o.id,
          name: o.name,
          role: null as "active" | "wait" | "terminal" | null,
        })),
        statusFieldId: statusField.id,
        detectedEnvironment: environment,
      }
    );

    for (const plannedSkill of plannedSkills) {
      const skillName = skillNameForPath(skillsDir, plannedSkill.path);
      files.push(
        await planFileChange({
          path: plannedSkill.path,
          label: `Skill ${skillName}`,
          content: plannedSkill.content,
          mode: "create-only",
        })
      );
    }
  }

  return {
    projectId: projectDetail.id,
    githubProjectTitle: projectDetail.title,
    runtime,
    priority,
    lifecycle,
    waitStates: deriveWaitStates(statusField, lifecycle),
    skillsDir,
    skipSkills,
    environment,
    files,
  };
}

export async function writeEcosystem(
  opts: EcosystemOptions
): Promise<EcosystemResult> {
  const plan = await planEcosystem(opts);
  const afterCreateHookPath = join(opts.cwd, DEFAULT_AFTER_CREATE_HOOK_PATH);

  let afterCreateHookWritten = false;
  const skillsWritten: string[] = [];
  const skillsSkipped: string[] = [];

  for (const file of plan.files) {
    const written = await writePlannedFile(file);
    if (file.path === afterCreateHookPath) {
      afterCreateHookWritten = written;
      continue;
    }
    if (file.label.startsWith("Skill ")) {
      const skillName = file.label.slice("Skill ".length);
      if (written) {
        skillsWritten.push(skillName);
      } else {
        skillsSkipped.push(skillName);
      }
    }
  }

  return {
    projectId: plan.projectId,
    githubProjectTitle: plan.githubProjectTitle,
    runtime: plan.runtime,
    priority: plan.priority,
    lifecycle: plan.lifecycle,
    waitStates: plan.waitStates,
    skillsDir: plan.skillsDir,
    skipSkills: plan.skipSkills,
    afterCreateHookWritten,
    contextYamlWritten: false,
    referenceWorkflowWritten: false,
    skillsWritten: [...new Set(skillsWritten)].sort(),
    skillsSkipped: [...new Set(skillsSkipped)].sort(),
    legacyFilesRemoved: [],
  };
}

// ── Ecosystem summary output ─────────────────────────────────────────────────

function formatPrioritySummaryLines(
  priority: WorkflowPriorityConfig
): string[] {
  if (priority.source === "disabled") {
    return ["Priority source   disabled"];
  }

  if (priority.source === "project-field") {
    const mapping = Object.entries(priority.values)
      .map(([name, value]) => `${name}=${value}`)
      .join(", ");
    return [
      "Priority source   project-field",
      `Priority mapping  ${priority.field}: ${mapping || "none"}`,
    ];
  }

  const mapping = Object.entries(priority.labels)
    .map(([name, value]) => `${name}=${value}`)
    .join(", ");
  return ["Priority source   labels", `Priority mapping  ${mapping || "none"}`];
}

function formatLifecycleValue(states: string[]): string {
  return states.length > 0 ? states.join(", ") : "disabled";
}

function formatLifecycleSummaryLines(
  lifecycle: WorkflowLifecycleConfig,
  waitStates: string[]
): string[] {
  return [
    "Lifecycle",
    `  Status field   ${lifecycle.stateFieldName}`,
    `  Active         ${lifecycle.activeStates.join(", ") || "(none)"}`,
    `  Wait           ${waitStates.join(", ") || "(none)"}`,
    `  Terminal       ${lifecycle.terminalStates.join(", ") || "(none)"}`,
    `  Blocker check  ${formatLifecycleValue(lifecycle.blockerCheckStates)}`,
    `  Planning       ${formatLifecycleValue(lifecycle.planningStates)}`,
  ];
}

function printEcosystemSummary(
  result: EcosystemResult,
  workflowPath: string,
  opts: { interactive: boolean; nextSteps?: string }
): void {
  const cwd = process.cwd();
  const relWorkflow = relative(cwd, workflowPath) || "WORKFLOW.md";

  const lines: string[] = [];
  lines.push(
    `GitHub Project   ${result.githubProjectTitle}  (${result.projectId})`
  );
  lines.push(`Runtime   ${result.runtime}`);
  lines.push(...formatPrioritySummaryLines(result.priority));
  lines.push("");
  lines.push(
    ...formatLifecycleSummaryLines(result.lifecycle, result.waitStates)
  );
  lines.push("");
  lines.push("Generated files");
  lines.push(`  ✓ WORKFLOW.md                          ${relWorkflow}`);
  if (result.afterCreateHookWritten) {
    lines.push(
      `  ✓ ${DEFAULT_AFTER_CREATE_HOOK_LABEL.padEnd(36)} ${DEFAULT_AFTER_CREATE_HOOK_PATH}`
    );
  }

  if (result.skillsDir) {
    const relSkillsDir = relative(cwd, result.skillsDir);
    lines.push("");
    lines.push(`Skills  →  ${relSkillsDir}/`);
    for (const name of result.skillsWritten) {
      lines.push(`  ✓ ${name}`);
    }
    for (const name of result.skillsSkipped) {
      lines.push(`  – ${name}  (already exists, skipped)`);
    }
  } else if (!result.skipSkills) {
    lines.push("");
    lines.push("Skills  →  (skipped — custom runtime)");
  }

  if (opts.interactive) {
    p.note(lines.join("\n"), "Setup complete");
    p.outro(opts.nextSteps ?? "Ready.");
  } else {
    process.stdout.write(lines.map((l) => `  ${l}`).join("\n") + "\n");
  }
}

export function renderDryRunPreview(
  workflowPath: string,
  workflowPlan: PlannedFileChange,
  ecosystemPlan: EcosystemPlan
): string {
  const cwd = process.cwd();
  const relWorkflow = relative(cwd, workflowPath) || "WORKFLOW.md";
  const statusIcon: Record<PlannedChangeStatus, string> = {
    create: "+",
    update: "~",
    unchanged: "=",
  };
  const lines: string[] = [];

  lines.push("Init dry-run preview");
  lines.push(
    `GitHub Project   ${ecosystemPlan.githubProjectTitle}  (${ecosystemPlan.projectId})`
  );
  lines.push(`Runtime   ${ecosystemPlan.runtime}`);
  lines.push(...formatPrioritySummaryLines(ecosystemPlan.priority));
  lines.push("");
  lines.push(
    ...formatLifecycleSummaryLines(
      ecosystemPlan.lifecycle,
      ecosystemPlan.waitStates
    )
  );
  lines.push("");
  lines.push("Planned file changes");
  lines.push(
    `  ${statusIcon[workflowPlan.status]} ${workflowPlan.status.padEnd(9)} WORKFLOW.md                          ${relWorkflow}`
  );
  for (const file of ecosystemPlan.files) {
    const relPath = relative(cwd, file.path) || file.path;
    lines.push(
      `  ${statusIcon[file.status]} ${file.status.padEnd(9)} ${file.label.padEnd(36)} ${relPath}`
    );
  }
  lines.push("");
  lines.push("Detected environment inputs");
  for (const line of summarizeEnvironment(ecosystemPlan.environment)) {
    lines.push(`  ${line}`);
  }
  lines.push("");
  lines.push("Dry run only. No files were written.");

  return lines.join("\n") + "\n";
}

export function buildDryRunJsonResult(
  workflowPath: string,
  workflowPlan: PlannedFileChange,
  ecosystemPlan: EcosystemPlan
): DryRunJsonResult {
  return {
    dryRun: true,
    output: workflowPath,
    projectId: ecosystemPlan.projectId,
    githubProjectTitle: ecosystemPlan.githubProjectTitle,
    runtime: ecosystemPlan.runtime,
    priority: ecosystemPlan.priority,
    files: [workflowPlan, ...ecosystemPlan.files].map((file) => ({
      path: file.path,
      label: file.label,
      status: file.status,
      mode: file.mode,
    })),
    environment: ecosystemPlan.environment,
  };
}

function printDryRunPreview(
  workflowPath: string,
  workflowPlan: PlannedFileChange,
  ecosystemPlan: EcosystemPlan
): void {
  process.stdout.write(
    renderDryRunPreview(workflowPath, workflowPlan, ecosystemPlan)
  );
}

// ── Non-interactive mode: WORKFLOW.md only ───────────────────────────────────

async function runNonInteractive(
  flags: InitFlags,
  options: GlobalOptions
): Promise<void> {
  const runtime = resolveInitRuntime(flags.runtime);
  const runtimeError = validateInitRuntime(runtime);
  if (runtimeError) {
    process.stderr.write(`Error: ${runtimeError}\n`);
    process.exitCode = 1;
    return;
  }
  if (!(await runInitRuntimePreflight(runtime))) {
    process.exitCode = 1;
    return;
  }

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

  // Validate token
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

  // Find project
  const projects = await listUserProjects(client);
  let githubProject: ProjectDetail | undefined;

  if (flags.project) {
    const match = projects.find(
      (proj) => proj.id === flags.project || proj.url === flags.project
    );
    if (!match) {
      process.stderr.write(`Error: Project not found: ${flags.project}\n`);
      process.exitCode = 1;
      return;
    }
    githubProject = await getProjectDetail(client, match.id);
  } else if (projects.length === 1) {
    githubProject = await getProjectDetail(client, projects[0]!.id);
  } else {
    process.stderr.write(
      "Error: --project is required when multiple projects exist.\n"
    );
    process.exitCode = 1;
    return;
  }

  // Auto-map with smart defaults
  const statusField = resolveStatusField(githubProject);

  if (!statusField) {
    process.stderr.write("Error: No status field found on the project.\n");
    process.exitCode = 1;
    return;
  }

  const mappings = buildAutomaticStateMappings(statusField);
  const { field: autoPriorityField, ambiguous: ambiguousPriorityFields } =
    resolvePriorityField(githubProject, statusField);
  if (ambiguousPriorityFields.length > 0) {
    process.stderr.write(
      `Warning: Multiple priority-like single-select fields found (${ambiguousPriorityFields.map((field) => `"${field.name}"`).join(", ")}). Writing disabled priority scaffold in non-interactive mode.\n`
    );
  }
  const priority = autoPriorityField
    ? buildProjectFieldPriority(autoPriorityField)
    : buildDisabledPriority();

  const validation = validateStateMapping(mappings);
  if (!validation.valid) {
    process.stderr.write(
      `Error: Cannot auto-map columns. ${validation.errors.join("; ")}\nRun without --non-interactive for manual mapping.\n`
    );
    process.exitCode = 1;
    return;
  }
  const defaultBlockerCheckStates = getDefaultBlockerCheckStates(
    toWorkflowLifecycleConfig(statusField.name, mappings)
  );
  const lifecycle = toWorkflowLifecycleConfig(statusField.name, mappings, {
    blockerCheckStates: defaultBlockerCheckStates,
    planningStates: defaultBlockerCheckStates,
  });

  const outputPath = resolve(flags.output ?? "WORKFLOW.md");
  const { workflowPlan, ecosystemPlan } = await planWorkflowArtifacts({
    cwd: process.cwd(),
    outputPath,
    projectDetail: githubProject,
    statusField,
    priorityField: autoPriorityField,
    priority,
    includePriorityTemplates: !autoPriorityField,
    mappings,
    lifecycle,
    runtime,
    skipSkills: flags.skipSkills,
    skipContext: flags.skipContext,
  });

  if (flags.dryRun) {
    if (options.json) {
      process.stdout.write(
        JSON.stringify(
          buildDryRunJsonResult(outputPath, workflowPlan, ecosystemPlan)
        ) + "\n"
      );
      return;
    }
    printDryRunPreview(outputPath, workflowPlan, ecosystemPlan);
    return;
  }

  await writeWorkflowPlan(workflowPlan);

  const ecosystemResult = await writeEcosystem({
    cwd: process.cwd(),
    projectDetail: githubProject,
    statusField,
    priorityField: autoPriorityField,
    priority,
    includePriorityTemplates: !autoPriorityField,
    lifecycle,
    runtime,
    skipSkills: flags.skipSkills,
    skipContext: flags.skipContext,
  });

  if (options.json) {
    process.stdout.write(
      JSON.stringify({ output: outputPath, status: workflowPlan.status }) + "\n"
    );
  } else {
    printEcosystemSummary(ecosystemResult, outputPath, {
      interactive: false,
      nextSteps: "Run 'gh-symphony repo init' from the target repository.",
    });
  }
}

// ── Interactive mode: WORKFLOW.md generation ─────────────────────────────────

async function runInteractive(
  flags: InitFlags,
  options: GlobalOptions
): Promise<void> {
  p.intro("gh-symphony — WORKFLOW.md Setup");
  await runInteractiveStandalone(flags, options);
}

// ── Interactive WORKFLOW.md generation ────────────────────────────────────────

async function runInteractiveStandalone(
  flags: InitFlags,
  _options: GlobalOptions
): Promise<void> {
  const runtime = await promptRuntimeSelection();
  if (isClaudeRuntime(runtime)) {
    if (!(await runInitRuntimePreflight(runtime))) {
      process.exitCode = 1;
      return;
    }
  } else {
    runRuntimePreflight(runtime);
  }

  const s1 = p.spinner();
  s1.start("Checking GitHub authentication...");

  let client: GitHubClient;

  try {
    const auth = await resolveGitHubAuth();
    const sourceLabel =
      auth.source === "env" ? "GITHUB_GRAPHQL_TOKEN" : "gh CLI";
    client = createClient(auth.token);
    s1.stop(`Authenticated via ${sourceLabel} as ${auth.login}`);
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

  // Project selection
  const s2 = p.spinner();
  s2.start("Loading projects...");
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
      displayScopeError(error, "gh-symphony workflow init");
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

  const selectedGithubProjectId = await abortIfCancelled(
    p.select({
      message: "Step 2/5 — Select a GitHub Project board:",
      options: projects.map((proj) => ({
        value: proj.id,
        label: `${proj.owner.login}/${proj.title}`,
        hint: `${proj.openItemCount} items`,
      })),
      maxItems: 15,
    })
  );

  const s2d = p.spinner();
  s2d.start("Loading project details...");
  let projectDetail: ProjectDetail;
  try {
    projectDetail = await getProjectDetail(client, selectedGithubProjectId);
    s2d.stop(`Loaded: ${projectDetail.title}`);
  } catch (error) {
    s2d.stop("Failed to load project details.");
    p.log.error(error instanceof Error ? error.message : "Unknown error");
    process.exitCode = 1;
    return;
  }

  // Step 3: Status column mapping
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
    stepLabel: "Step 3/5",
  });

  const validation = validateStateMapping(mappings);
  if (!validation.valid) {
    p.log.error("Mapping validation failed:");
    for (const err of validation.errors) {
      p.log.error(`  • ${err}`);
    }
    process.exitCode = 1;
    return;
  }
  for (const warn of validation.warnings) {
    p.log.warn(`  ⚠ ${warn}`);
  }

  const lifecycleBase = toWorkflowLifecycleConfig(statusField.name, mappings);
  const blockerCheckStates = await promptBlockerCheck(lifecycleBase, {
    stepLabel: "Step 4/5",
  });
  const lifecycle = toWorkflowLifecycleConfig(statusField.name, mappings, {
    blockerCheckStates,
    planningStates: blockerCheckStates,
  });
  const { priority, priorityField } = await promptPriorityConfig({
    priorityResolution,
    labelNames: priorityLabelNames,
    stepLabel: "Step 5/5",
  });

  const outputPath = resolve(flags.output ?? "WORKFLOW.md");
  const { workflowPlan, ecosystemPlan } = await planWorkflowArtifacts({
    cwd: process.cwd(),
    outputPath,
    projectDetail,
    statusField,
    priorityField,
    priority,
    includePriorityTemplates: priority.source === "disabled",
    mappings,
    lifecycle,
    runtime,
    skipSkills: flags.skipSkills,
    skipContext: flags.skipContext,
  });

  if (flags.dryRun) {
    printDryRunPreview(outputPath, workflowPlan, ecosystemPlan);
    return;
  }

  await promptLegacyGhSymphonyCleanup(process.cwd());
  await writeWorkflowPlan(workflowPlan);

  const ecosystemResult = await writeEcosystem({
    cwd: process.cwd(),
    projectDetail,
    statusField,
    priorityField,
    priority,
    includePriorityTemplates: priority.source === "disabled",
    lifecycle,
    runtime,
    skipSkills: flags.skipSkills,
    skipContext: flags.skipContext,
  });

  printEcosystemSummary(ecosystemResult, outputPath, {
    interactive: true,
    nextSteps: "Run 'gh-symphony repo init' from the target repository.",
  });
}

// ── Config writing (used by setup via import) ──────────────────────────────────

type WriteConfigInput = {
  projectId: string;
  project: ProjectDetail;
  repos: LinkedRepository[];
  workspaceDir: string;
  maxAttempts?: number;
};

export async function writeConfig(
  configDir: string,
  input: WriteConfigInput
): Promise<void> {
  const repository = input.repos[0];

  await saveProjectConfig(configDir, input.projectId, {
    projectId: input.projectId,
    slug: input.projectId,
    displayName: input.project.title,
    workspaceDir: input.workspaceDir,
    ...(repository
      ? {
          repository: {
            owner: repository.owner,
            name: repository.name,
            cloneUrl: repository.cloneUrl,
          },
        }
      : {}),
    tracker: {
      adapter: "github-project",
      bindingId: input.project.id,
      settings: {
        projectId: input.project.id,
        ...(input.repos[0]
          ? { repository: `${repository.owner}/${repository.name}` }
          : {}),
      },
    },
  });

  // Save/update global config
  const existing = await loadGlobalConfig(configDir);
  const globalConfig: CliGlobalConfig = {
    activeProject: input.projectId,
    projects: [
      ...(existing?.projects ?? []).filter((t) => t !== input.projectId),
      input.projectId,
    ],
  };
  await saveGlobalConfig(configDir, globalConfig);
}

export function generateProjectId(
  githubProjectTitle: string,
  uniqueKey: string
): string {
  const slug = githubProjectTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
  const suffix = createHash("sha1").update(uniqueKey).digest("hex").slice(0, 8);
  return [slug || "project", suffix].join("-");
}
