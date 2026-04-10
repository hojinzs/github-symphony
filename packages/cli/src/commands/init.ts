import * as p from "@clack/prompts";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { GlobalOptions } from "../index.js";
import {
  createClient,
  validateToken,
  checkRequiredScopes,
  discoverUserProjects,
  listUserProjects,
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
import {
  getGhTokenWithSource,
  GhAuthError,
} from "../github/gh-auth.js";
import { resolveGitHubAuth } from "../github/gh-auth.js";
import { detectEnvironment } from "../detection/environment-detector.js";
import {
  buildContextYaml,
  generateContextYamlString,
} from "../context/generate-context-yaml.js";
import { generateReferenceWorkflow } from "../workflow/generate-reference-workflow.js";
import { buildSkillFilePlans, resolveSkillsDir } from "../skills/skill-writer.js";
import { ALL_SKILL_TEMPLATES } from "../skills/templates/index.js";

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
  result: Pick<ProjectDiscoveryResult, "partial" | "reason" | "projects" | "requests">
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
  skipSkills: boolean;
  skipContext: boolean;
};

function parseInitFlags(args: string[]): InitFlags {
  const flags: InitFlags = {
    dryRun: false,
    nonInteractive: false,
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

// ── Init command handler ─────────────────────────────────────────────────────

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => {
  const flags = parseInitFlags(args);

  if (flags.nonInteractive) {
    await runNonInteractive(flags, options);
    return;
  }

  await runInteractive(flags, options);
};

export default handler;

// ── Ecosystem file generation ────────────────────────────────────────────────

type EcosystemOptions = {
  cwd: string;
  projectDetail: ProjectDetail;
  statusField: ProjectStatusField;
  runtime: string;
  skipSkills: boolean;
  skipContext: boolean;
};

export type EcosystemResult = {
  projectId: string;
  githubProjectTitle: string;
  runtime: string;
  skillsDir: string | null;
  contextYamlWritten: boolean;
  referenceWorkflowWritten: boolean;
  skillsWritten: string[];
  skillsSkipped: string[];
};

type PlannedWriteMode = "overwrite" | "create-only";
type PlannedChangeStatus = "create" | "update" | "unchanged";

export type PlannedFileChange = {
  path: string;
  label: string;
  content: string;
  mode: PlannedWriteMode;
  status: PlannedChangeStatus;
};

export type EcosystemPlan = {
  projectId: string;
  githubProjectTitle: string;
  runtime: string;
  skillsDir: string | null;
  environment: Awaited<ReturnType<typeof detectEnvironment>>;
  files: PlannedFileChange[];
};

export type DryRunJsonResult = {
  dryRun: true;
  output: string;
  projectId: string;
  githubProjectTitle: string;
  runtime: string;
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
  mappings: Record<string, StateMapping>;
  runtime: string;
  skipSkills: boolean;
  skipContext: boolean;
};

export type WorkflowArtifactsPlan = {
  outputPath: string;
  workflowMd: string;
  workflowPlan: PlannedFileChange;
  ecosystemPlan: EcosystemPlan;
};

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
  return true;
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
  for (const mapping of inferAllStateRoles(statusField.options.map((o) => o.name))) {
    if (mapping.role) {
      mappings[mapping.columnName] = { role: mapping.role };
    }
  }
  return mappings;
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

export async function planWorkflowArtifacts(
  opts: WorkflowArtifactsOptions
): Promise<WorkflowArtifactsPlan> {
  const workflowMd = generateWorkflowMarkdown({
    projectId: opts.projectDetail.id,
    stateFieldName: opts.statusField.name,
    mappings: opts.mappings,
    lifecycle: toWorkflowLifecycleConfig(opts.statusField.name, opts.mappings),
    runtime: opts.runtime,
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
    runtime: opts.runtime,
    skipSkills: opts.skipSkills,
    skipContext: opts.skipContext,
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

export async function planEcosystem(
  opts: EcosystemOptions
): Promise<EcosystemPlan> {
  const { cwd, projectDetail, statusField, runtime, skipSkills, skipContext } =
    opts;
  const ghSymphonyDir = join(cwd, ".gh-symphony");
  const environment = await detectEnvironment(cwd);
  const files: PlannedFileChange[] = [];

  if (!skipContext) {
    const contextYaml = buildContextYaml({
      projectDetail,
      statusField,
      detectedEnvironment: environment,
      runtime: {
        agent: runtime,
        agent_command:
          runtime === "codex"
            ? "bash -lc codex app-server"
            : runtime === "claude-code"
              ? "bash -lc claude-code"
              : runtime,
      },
    });
    files.push(
      await planFileChange({
        path: join(ghSymphonyDir, "context.yaml"),
        label: "Context metadata",
        content: generateContextYamlString(contextYaml),
        mode: "overwrite",
      })
    );
  }

  const referenceWorkflow = generateReferenceWorkflow({
    runtime,
    statusColumns: statusField.options.map((o) => ({
      name: o.name,
      role: null as "active" | "wait" | "terminal" | null,
    })),
    projectId: projectDetail.id,
  });
  files.push(
    await planFileChange({
      path: join(ghSymphonyDir, "reference-workflow.md"),
      label: "Reference workflow",
      content: referenceWorkflow,
      mode: "overwrite",
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
        contextYamlPath: ".gh-symphony/context.yaml",
        referenceWorkflowPath: ".gh-symphony/reference-workflow.md",
      }
    );

    for (const plannedSkill of plannedSkills) {
      files.push(
        await planFileChange({
          path: plannedSkill.path,
          label: `Skill ${basename(dirname(plannedSkill.path))}`,
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
    skillsDir,
    environment,
    files,
  };
}

export async function writeEcosystem(
  opts: EcosystemOptions
): Promise<EcosystemResult> {
  const plan = await planEcosystem(opts);
  await mkdir(join(opts.cwd, ".gh-symphony"), { recursive: true });
  const contextYamlPath = join(opts.cwd, ".gh-symphony", "context.yaml");
  const referenceWorkflowPath = join(
    opts.cwd,
    ".gh-symphony",
    "reference-workflow.md"
  );

  let contextYamlWritten = false;
  let referenceWorkflowWritten = false;
  const skillsWritten: string[] = [];
  const skillsSkipped: string[] = [];

  for (const file of plan.files) {
    const written = await writePlannedFile(file);
    if (file.path === contextYamlPath) {
      contextYamlWritten = written;
      continue;
    }
    if (file.path === referenceWorkflowPath) {
      referenceWorkflowWritten = written;
      continue;
    }
    if (file.label.startsWith("Skill ")) {
      const skillName = basename(dirname(file.path));
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
    skillsDir: plan.skillsDir,
    contextYamlWritten,
    referenceWorkflowWritten,
    skillsWritten: skillsWritten.sort(),
    skillsSkipped: skillsSkipped.sort(),
  };
}

// ── Ecosystem summary output ─────────────────────────────────────────────────

function printEcosystemSummary(
  result: EcosystemResult,
  workflowPath: string,
  opts: { interactive: boolean; nextSteps?: string }
): void {
  const cwd = process.cwd();
  const relWorkflow = relative(cwd, workflowPath) || "WORKFLOW.md";

  const lines: string[] = [];
  lines.push(`GitHub Project   ${result.githubProjectTitle}  (${result.projectId})`);
  lines.push(`Runtime   ${result.runtime}`);
  lines.push("");
  lines.push("Generated files");
  lines.push(`  ✓ WORKFLOW.md                          ${relWorkflow}`);
  if (result.contextYamlWritten) {
    lines.push(
      "  ✓ Context metadata                     .gh-symphony/context.yaml"
    );
  }
  if (result.referenceWorkflowWritten) {
    lines.push(
      "  ✓ Reference workflow                   .gh-symphony/reference-workflow.md"
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
  } else if (result.runtime !== "codex" && result.runtime !== "claude-code") {
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

  const validation = validateStateMapping(mappings);
  if (!validation.valid) {
    process.stderr.write(
      `Error: Cannot auto-map columns. ${validation.errors.join("; ")}\nRun without --non-interactive for manual mapping.\n`
    );
    process.exitCode = 1;
    return;
  }

  const outputPath = resolve(flags.output ?? "WORKFLOW.md");
  const { workflowPlan, ecosystemPlan } = await planWorkflowArtifacts({
    cwd: process.cwd(),
    outputPath,
    projectDetail: githubProject,
    statusField,
    mappings,
    runtime: "codex",
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
    runtime: "codex",
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
      nextSteps: "Run 'gh-symphony project add' to register a project.",
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

  // Step 1/2: Project selection
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
      message: "Step 1/2 — Select a GitHub Project board:",
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

  const mappings = await promptStateMappings(statusField);

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

  const outputPath = resolve(flags.output ?? "WORKFLOW.md");
  const { workflowPlan, ecosystemPlan } = await planWorkflowArtifacts({
    cwd: process.cwd(),
    outputPath,
    projectDetail,
    statusField,
    mappings,
    runtime: "codex",
    skipSkills: flags.skipSkills,
    skipContext: flags.skipContext,
  });

  if (flags.dryRun) {
    printDryRunPreview(outputPath, workflowPlan, ecosystemPlan);
    return;
  }

  await writeWorkflowPlan(workflowPlan);

  const ecosystemResult = await writeEcosystem({
    cwd: process.cwd(),
    projectDetail,
    statusField,
    runtime: "codex",
    skipSkills: flags.skipSkills,
    skipContext: flags.skipContext,
  });

  printEcosystemSummary(ecosystemResult, outputPath, {
    interactive: true,
    nextSteps: "Run 'gh-symphony project add' to register a project.",
  });
}

// ── Config writing (used by project.ts via import) ─────────────────────────────

type WriteConfigInput = {
  projectId: string;
  project: ProjectDetail;
  repos: LinkedRepository[];
  workspaceDir: string;
  maxAttempts?: number;
  assignedOnly?: boolean;
};

export async function writeConfig(
  configDir: string,
  input: WriteConfigInput
): Promise<void> {
  await saveProjectConfig(configDir, input.projectId, {
    projectId: input.projectId,
    slug: input.projectId,
    displayName: input.project.title,
    workspaceDir: input.workspaceDir,
    repositories: input.repos.map((r) => ({
      owner: r.owner,
      name: r.name,
      cloneUrl: r.cloneUrl,
    })),
    tracker: {
      adapter: "github-project",
      bindingId: input.project.id,
      settings: {
        projectId: input.project.id,
        ...(input.assignedOnly ? { assignedOnly: true } : {}),
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
