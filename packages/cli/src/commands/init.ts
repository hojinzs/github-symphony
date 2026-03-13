import * as p from "@clack/prompts";
import { parseWorkflowMarkdown } from "@gh-symphony/core";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { GlobalOptions } from "../index.js";
import {
  createClient,
  validateToken,
  checkRequiredScopes,
  listUserProjects,
  getProjectDetail,
  type GitHubClient,
  type ProjectSummary,
  type ProjectDetail,
  type ProjectStatusField,
  type ProjectTextField,
  type LinkedRepository,
} from "../github/client.js";
import {
  inferAllStateRoles,
  inferBlockedByFieldName,
  toWorkflowLifecycleConfig,
  validateStateMapping,
} from "../mapping/smart-defaults.js";
import { generateWorkflowMarkdown } from "../workflow/generate-workflow-md.js";
import {
  loadGlobalConfig,
  loadTenantConfig,
  saveGlobalConfig,
  saveTenantConfig,
  saveWorkflowMapping,
  type CliGlobalConfig,
  type StateRole,
  type StateMapping,
  type WorkflowStateConfig,
} from "../config.js";
import { detectEnvironment } from "../detection/environment-detector.js";
import {
  buildContextYaml,
  writeContextYaml,
} from "../context/generate-context-yaml.js";
import { generateReferenceWorkflow } from "../workflow/generate-reference-workflow.js";
import { resolveSkillsDir, writeAllSkills } from "../skills/skill-writer.js";
import { ALL_SKILL_TEMPLATES } from "../skills/templates/index.js";

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
  nonInteractive: boolean;
  token?: string;
  project?: string;
  output?: string;
  skipSkills: boolean;
  skipContext: boolean;
};

function parseInitFlags(args: string[]): InitFlags {
  const flags: InitFlags = {
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
      case "--token":
        flags.token = next;
        i += 1;
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

  await runInteractive(options);
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
  projectTitle: string;
  runtime: string;
  skillsDir: string | null;
  contextYamlWritten: boolean;
  referenceWorkflowWritten: boolean;
  skillsWritten: string[];
  skillsSkipped: string[];
};

function inferAgentRuntimeFromCommand(command?: string): string | null {
  if (!command) {
    return null;
  }

  if (command.includes("claude-code")) {
    return "claude-code";
  }

  if (command.includes("codex")) {
    return "codex";
  }

  return null;
}

function isWorkerBootstrapCommand(command: string): boolean {
  return (
    command.includes("@gh-symphony/worker/dist/index.js") ||
    command.includes("packages/worker/dist/index.js")
  );
}

function isMissingAgentEnvError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(
      "Workflow front matter requires environment variable"
    )
  );
}

export async function resolveTenantRuntime(
  configDir: string,
  tenantId: string,
  tenantWorkerCommand?: string
): Promise<string> {
  const workflowPath = join(configDir, "tenants", tenantId, "WORKFLOW.md");
  try {
    const workflowMarkdown = await readFile(workflowPath, "utf8");
    const agentCommand = parseWorkflowMarkdown(
      workflowMarkdown,
      {}
    ).agentCommand;
    if (!isWorkerBootstrapCommand(agentCommand)) {
      return agentCommand;
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT" && !isMissingAgentEnvError(error)) {
      throw error;
    }
  }

  return inferAgentRuntimeFromCommand(tenantWorkerCommand) ?? "codex";
}

export async function writeEcosystem(
  opts: EcosystemOptions
): Promise<EcosystemResult> {
  const { cwd, projectDetail, statusField, runtime, skipSkills, skipContext } =
    opts;
  const ghSymphonyDir = join(cwd, ".gh-symphony");
  await mkdir(ghSymphonyDir, { recursive: true });

  // 1. Detect environment
  const env = await detectEnvironment(cwd);

  // 2. Write context.yaml (unless --skip-context)
  let contextYamlWritten = false;
  if (!skipContext) {
    const contextYaml = buildContextYaml({
      projectDetail,
      statusField,
      detectedEnvironment: env,
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
    await writeContextYaml(cwd, contextYaml);
    contextYamlWritten = true;
  }

  // 3. Write reference-workflow.md
  const refWorkflow = generateReferenceWorkflow({
    runtime,
    statusColumns: statusField.options.map((o) => ({
      name: o.name,
      role: null as "active" | "wait" | "terminal" | null,
    })),
    projectId: projectDetail.id,
  });
  const refPath = join(ghSymphonyDir, "reference-workflow.md");
  const tmpRef = refPath + ".tmp";
  await writeFile(tmpRef, refWorkflow, "utf8");
  await rename(tmpRef, refPath);

  // 4. Write skills (unless --skip-skills)
  const skillsDir = resolveSkillsDir(cwd, runtime);
  let skillsWritten: string[] = [];
  let skillsSkipped: string[] = [];
  if (!skipSkills && skillsDir) {
    const result = await writeAllSkills(cwd, runtime, ALL_SKILL_TEMPLATES, {
      runtime,
      projectId: projectDetail.id,
      projectTitle: projectDetail.title,
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
    });
    skillsWritten = result.written.map((p) => basename(dirname(p)));
    skillsSkipped = result.skipped.map((p) => basename(dirname(p)));
  }

  return {
    projectId: projectDetail.id,
    projectTitle: projectDetail.title,
    runtime,
    skillsDir,
    contextYamlWritten,
    referenceWorkflowWritten: true,
    skillsWritten,
    skillsSkipped,
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
  lines.push(`Project   ${result.projectTitle}  (${result.projectId})`);
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

// ── Non-interactive mode: WORKFLOW.md only ───────────────────────────────────

async function runNonInteractive(
  flags: InitFlags,
  options: GlobalOptions
): Promise<void> {
  if (!flags.token) {
    process.stderr.write(
      "Error: --token is required in non-interactive mode.\n"
    );
    process.exitCode = 1;
    return;
  }

  const client = createClient(flags.token);

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
  let project: ProjectDetail | undefined;

  if (flags.project) {
    const match = projects.find(
      (proj) => proj.id === flags.project || proj.url === flags.project
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

  // Auto-map with smart defaults
  const statusField =
    project.statusFields.find((f) => f.name.toLowerCase() === "status") ??
    project.statusFields[0];

  if (!statusField) {
    process.stderr.write("Error: No status field found on the project.\n");
    process.exitCode = 1;
    return;
  }

  const columnNames = statusField.options.map((o) => o.name);
  const inferred = inferAllStateRoles(columnNames);
  const mappings: Record<string, StateMapping> = {};
  for (const mapping of inferred) {
    if (mapping.role) {
      mappings[mapping.columnName] = { role: mapping.role };
    }
  }

  const validation = validateStateMapping(mappings);
  if (!validation.valid) {
    process.stderr.write(
      `Error: Cannot auto-map columns. ${validation.errors.join("; ")}\nRun without --non-interactive for manual mapping.\n`
    );
    process.exitCode = 1;
    return;
  }

  const lifecycleConfig = toWorkflowLifecycleConfig(statusField.name, mappings);
  const textFieldNames = project.textFields.map((f) => f.name);
  const blockedByFieldName =
    inferBlockedByFieldName(textFieldNames) ?? undefined;
  const outputPath = resolve(flags.output ?? "WORKFLOW.md");

  const workflowMd = generateWorkflowMarkdown({
    projectId: project.id,
    stateFieldName: statusField.name,
    mappings,
    lifecycle: lifecycleConfig,
    runtime: "codex",
    blockedByFieldName,
  });

  await writeFile(outputPath, workflowMd, "utf8");

  const ecosystemResult = await writeEcosystem({
    cwd: process.cwd(),
    projectDetail: project,
    statusField,
    runtime: "codex",
    skipSkills: flags.skipSkills,
    skipContext: flags.skipContext,
  });

  if (options.json) {
    process.stdout.write(
      JSON.stringify({ output: outputPath, status: "created" }) + "\n"
    );
  } else {
    printEcosystemSummary(ecosystemResult, outputPath, {
      interactive: false,
      nextSteps: "Run 'gh-symphony tenant add' to register a tenant.",
    });
  }
}

// ── Interactive mode: WORKFLOW.md generation ─────────────────────────────────

async function runInteractive(options: GlobalOptions): Promise<void> {
  p.intro("gh-symphony — WORKFLOW.md Setup");

  // Case A: tenant(s) already configured
  const globalConfig = await loadGlobalConfig(options.configDir);
  if (globalConfig?.tenants?.length) {
    await runInteractiveFromTenant(globalConfig, options);
    return;
  }

  // Case B: no tenants — standalone WORKFLOW.md generation
  await runInteractiveStandalone(options);
}

// ── Case A: Generate WORKFLOW.md from existing tenant config ─────────────────

async function runInteractiveFromTenant(
  globalConfig: CliGlobalConfig,
  options: GlobalOptions
): Promise<void> {
  const tenants = globalConfig.tenants;

  let tenantId: string;
  if (tenants.length === 1) {
    tenantId = tenants[0]!;
  } else {
    // Multiple tenants: ask which one to base WORKFLOW.md on
    const tenantConfigs = await Promise.all(
      tenants.map(async (id) => {
        const cfg = await loadTenantConfig(options.configDir, id);
        return { id, label: cfg?.slug ?? id };
      })
    );

    tenantId = await abortIfCancelled(
      p.select({
        message: "Select a tenant to base WORKFLOW.md on:",
        options: tenantConfigs.map((t) => ({
          value: t.id,
          label: t.label,
          hint: globalConfig.activeTenant === t.id ? "active" : undefined,
        })),
      })
    );
  }

  const tenantConfig = await loadTenantConfig(options.configDir, tenantId);
  if (!tenantConfig) {
    p.log.error(`Tenant config not found for "${tenantId}".`);
    process.exitCode = 1;
    return;
  }

  const lifecycle = tenantConfig.workflowMapping?.lifecycle;
  if (!lifecycle) {
    p.log.error(
      `Tenant "${tenantId}" has no workflow lifecycle config. Run 'gh-symphony tenant add' first.`
    );
    process.exitCode = 1;
    return;
  }

  const mappings: Record<string, StateMapping> = {};
  const workflowMapping = tenantConfig.workflowMapping;
  if (workflowMapping) {
    Object.assign(mappings, workflowMapping.mappings);
  }

  const projectId = tenantConfig.tracker.settings?.projectId as
    | string
    | undefined;
  const stateFieldName =
    workflowMapping?.stateFieldName ?? lifecycle.stateFieldName;
  const runtime = await resolveTenantRuntime(
    options.configDir,
    tenantId,
    tenantConfig.runtime.workerCommand
  );

  const workflowMd = generateWorkflowMarkdown({
    projectId: projectId ?? "",
    stateFieldName,
    mappings,
    lifecycle,
    runtime,
  });

  const outputPath = resolve("WORKFLOW.md");
  await writeFile(outputPath, workflowMd, "utf8");

  const token = globalConfig.token;
  const projId = tenantConfig.tracker.settings?.projectId as string | undefined;
  let ecosystemResult: EcosystemResult | null = null;
  if (token && projId) {
    try {
      const client = createClient(token);
      const fullProject = await getProjectDetail(client, projId);
      const sf =
        fullProject.statusFields.find(
          (f) => f.name.toLowerCase() === stateFieldName.toLowerCase()
        ) ?? fullProject.statusFields[0];
      if (sf) {
        ecosystemResult = await writeEcosystem({
          cwd: process.cwd(),
          projectDetail: fullProject,
          statusField: sf,
          runtime,
          skipSkills: false,
          skipContext: false,
        });
      }
    } catch {
      // best-effort: don't fail init if GitHub API is unreachable
    }
  }

  if (ecosystemResult) {
    printEcosystemSummary(ecosystemResult, outputPath, { interactive: true });
  } else {
    p.outro(`WORKFLOW.md generated at ${outputPath}`);
  }
}

// ── Case B: Standalone WORKFLOW.md generation (no tenant) ────────────────────

async function runInteractiveStandalone(
  _options: GlobalOptions
): Promise<void> {
  // Step 1: PAT input
  let client!: GitHubClient;

  while (true) {
    const rawToken = await abortIfCancelled(
      p.password({
        message: "Step 1/3 — Enter your GitHub Personal Access Token:",
        validate: (v) => {
          if (!v) return "Token is required.";
          if (v.length < 40) return "Token too short.";
        },
      })
    );

    client = createClient(rawToken);
    const s = p.spinner();
    s.start("Validating token...");

    try {
      const viewer = await validateToken(client);
      const scopeCheck = checkRequiredScopes(viewer.scopes);

      if (!scopeCheck.valid) {
        s.stop(
          `Token valid (${viewer.login}), but missing scopes: ${scopeCheck.missing.join(", ")}`
        );
        p.log.warn(
          "Required scopes: repo, read:org, project. Please create a new token with these scopes."
        );
        continue;
      }

      s.stop(
        `Authenticated as ${viewer.login}${viewer.name ? ` (${viewer.name})` : ""}`
      );
      break;
    } catch (error) {
      s.stop(
        `Token invalid: ${error instanceof Error ? error.message : "Unknown error"}`
      );
      p.log.warn("Please try a different token.");
    }
  }

  // Step 2: Project selection
  const s2 = p.spinner();
  s2.start("Loading projects...");
  let projects: ProjectSummary[];
  try {
    projects = await listUserProjects(client);
    s2.stop(
      `Found ${projects.length} project${projects.length === 1 ? "" : "s"}`
    );
  } catch (error) {
    s2.stop("Failed to load projects.");
    p.log.error(error instanceof Error ? error.message : "Unknown error");
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
      message: "Step 2/3 — Select a GitHub Project:",
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
    projectDetail = await getProjectDetail(client, selectedProjectId);
    s2d.stop(`Loaded: ${projectDetail.title}`);
  } catch (error) {
    s2d.stop("Failed to load project details.");
    p.log.error(error instanceof Error ? error.message : "Unknown error");
    process.exitCode = 1;
    return;
  }

  // Step 3: Status column mapping
  const statusField =
    projectDetail.statusFields.find((f) => f.name.toLowerCase() === "status") ??
    projectDetail.statusFields[0];

  if (!statusField) {
    p.log.error(
      "No status field found on the project. The project needs a single-select 'Status' field."
    );
    process.exitCode = 1;
    return;
  }

  const columnNames = statusField.options.map((o) => o.name);
  const inferred = inferAllStateRoles(columnNames);

  p.log.info(
    `Found ${columnNames.length} status columns on field "${statusField.name}".`
  );

  const mappings: Record<string, StateMapping> = {};
  for (const mapping of inferred) {
    const roleOptions: Array<{ value: StateRole | "skip"; label: string }> = [
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
        message: `Step 3/3 — Map column "${mapping.columnName}":${mapping.confidence === "high" ? " (auto-detected)" : ""}`,
        options: sortedOptions,
      })
    );

    if (selectedRole !== "skip") {
      mappings[mapping.columnName] = { role: selectedRole as StateRole };
    }
  }

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

  const lifecycleConfig = toWorkflowLifecycleConfig(statusField.name, mappings);

  // Step 4: Blocker field selection (optional)
  const blockedByFieldName = await promptBlockedByField(
    projectDetail.textFields
  );

  // Generate WORKFLOW.md only — no config files written
  const workflowMd = generateWorkflowMarkdown({
    projectId: projectDetail.id,
    stateFieldName: statusField.name,
    mappings,
    lifecycle: lifecycleConfig,
    runtime: "codex",
    blockedByFieldName,
  });

  const outputPath = resolve("WORKFLOW.md");
  await writeFile(outputPath, workflowMd, "utf8");

  const ecosystemResult = await writeEcosystem({
    cwd: process.cwd(),
    projectDetail,
    statusField,
    runtime: "codex",
    skipSkills: false,
    skipContext: false,
  });

  printEcosystemSummary(ecosystemResult, outputPath, {
    interactive: true,
    nextSteps: "Run 'gh-symphony tenant add' to register a tenant.",
  });
}

async function promptBlockedByField(
  textFields: ProjectTextField[]
): Promise<string | undefined> {
  if (textFields.length === 0) {
    return undefined;
  }

  const autoDetected = inferBlockedByFieldName(textFields.map((f) => f.name));
  const IGNORE_VALUE = "__ignore__";

  const options: Array<{ value: string; label: string; hint?: string }> = [
    { value: IGNORE_VALUE, label: "Ignore (no blocker field)" },
    ...textFields.map((f) => ({
      value: f.name,
      label: f.name,
      hint:
        f.name === autoDetected ? "auto-detected" : f.dataType.toLowerCase(),
    })),
  ];

  // Move auto-detected to top of field options
  if (autoDetected) {
    const idx = options.findIndex((o) => o.value === autoDetected);
    if (idx > 1) {
      const [item] = options.splice(idx, 1);
      options.splice(1, 0, item!);
    }
  }

  const selected = await abortIfCancelled(
    p.select({
      message: `Step 4/4 — Select a custom field for "Blocked By" (optional):${autoDetected ? ` "${autoDetected}" auto-detected` : ""}`,
      options,
      initialValue: autoDetected ?? IGNORE_VALUE,
    })
  );

  return selected === IGNORE_VALUE ? undefined : selected;
}

// ── Config writing (used by tenant.ts via import) ─────────────────────────────

type WriteConfigInput = {
  tenantId: string;
  token: string;
  project: ProjectDetail;
  repos: LinkedRepository[];
  statusField: {
    id: string;
    name: string;
    options: Array<{ id: string; name: string; color?: string | null }>;
  };
  mappings: Record<string, StateMapping>;
  runtime: string;
  agentCommand?: string;
  workerCommand?: string;
  pollIntervalMs?: number;
  concurrency?: number;
  maxAttempts?: number;
  blockedByFieldName?: string;
};

function resolveWorkerCommand(): string | undefined {
  try {
    const url = import.meta.resolve("@gh-symphony/worker/dist/index.js");
    return `node ${fileURLToPath(url)}`;
  } catch {
    return undefined;
  }
}

export async function writeConfig(
  configDir: string,
  input: WriteConfigInput
): Promise<void> {
  const lifecycleConfig = toWorkflowLifecycleConfig(
    input.statusField.name,
    input.mappings
  );

  // Save workflow mapping
  const mappingConfig: WorkflowStateConfig = {
    stateFieldName: input.statusField.name,
    mappings: input.mappings,
    lifecycle: lifecycleConfig,
    blockedByFieldName: input.blockedByFieldName,
  };
  await saveWorkflowMapping(configDir, input.tenantId, mappingConfig);

  // Save tenant config (OrchestratorTenantConfig shape)
  const runtimeDir = `${configDir}/tenants/${input.tenantId}/runtime`;
  await saveTenantConfig(configDir, input.tenantId, {
    tenantId: input.tenantId,
    slug: input.tenantId,
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
        token: input.token,
        ...(input.blockedByFieldName && {
          blockedByFieldName: input.blockedByFieldName,
        }),
      },
    },
    runtime: {
      driver: "local",
      workspaceRuntimeDir: runtimeDir,
      projectRoot: process.cwd(),
      workerCommand: input.workerCommand ?? resolveWorkerCommand(),
    },
    workflowMapping: mappingConfig,
  });

  // Save/update global config
  const existing = await loadGlobalConfig(configDir);
  const globalConfig: CliGlobalConfig = {
    activeTenant: input.tenantId,
    token: input.token,
    tenants: [
      ...(existing?.tenants ?? []).filter((t) => t !== input.tenantId),
      input.tenantId,
    ],
  };
  await saveGlobalConfig(configDir, globalConfig);

  // Generate WORKFLOW.md for tenant-level fallback
  const workflowMd = generateWorkflowMarkdown({
    projectId: input.project.id,
    stateFieldName: input.statusField.name,
    mappings: input.mappings,
    lifecycle: lifecycleConfig,
    runtime: input.agentCommand ?? input.runtime,
    pollIntervalMs: input.pollIntervalMs,
    concurrency: input.concurrency,
    blockedByFieldName: input.blockedByFieldName,
  });
  const workflowMdPath = join(
    configDir,
    "tenants",
    input.tenantId,
    "WORKFLOW.md"
  );
  await writeFile(workflowMdPath, workflowMd, "utf8");
}

export function generateTenantId(
  projectTitle: string,
  uniqueKey: string
): string {
  const slug = projectTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
  const suffix = createHash("sha1").update(uniqueKey).digest("hex").slice(0, 8);
  return [slug || "tenant", suffix].join("-");
}
