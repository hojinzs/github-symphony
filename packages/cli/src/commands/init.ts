import * as p from "@clack/prompts";
import { createHash } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  saveTenantConfig,
  saveWorkflowMapping,
  type CliGlobalConfig,
  type StateRole,
  type StateMapping,
  type WorkflowStateConfig,
} from "../config.js";
import { getGhToken, ensureGhAuth, GhAuthError } from "../github/gh-auth.js";
import { detectEnvironment } from "../detection/environment-detector.js";
import {
  buildContextYaml,
  writeContextYaml,
} from "../context/generate-context-yaml.js";
import { generateReferenceWorkflow } from "../workflow/generate-reference-workflow.js";
import { resolveSkillsDir, writeAllSkills } from "../skills/skill-writer.js";
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
  const outputPath = resolve(flags.output ?? "WORKFLOW.md");

  const workflowMd = generateWorkflowMarkdown({
    projectId: project.id,
    stateFieldName: statusField.name,
    mappings,
    lifecycle: lifecycleConfig,
    runtime: "codex",
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
  await runInteractiveStandalone(options);
}

// ── Interactive WORKFLOW.md generation ────────────────────────────────────────

async function runInteractiveStandalone(
  _options: GlobalOptions
): Promise<void> {
  const s1 = p.spinner();
  s1.start("Checking gh CLI authentication...");

  let client: GitHubClient;

  try {
    const { token } = ensureGhAuth();
    client = createClient(token);
    s1.stop("Authenticated via gh CLI");
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

  // Step 1/2: Project selection
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
    if (error instanceof GitHubScopeError) {
      displayScopeError(error, "gh-symphony init");
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
      message: "Step 1/2 — Select a GitHub Project:",
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
        message: `Step 2/2 — Map column "${mapping.columnName}":${mapping.confidence === "high" ? " (auto-detected)" : ""}`,
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

  // Generate WORKFLOW.md only — no config files written
  const workflowMd = generateWorkflowMarkdown({
    projectId: projectDetail.id,
    stateFieldName: statusField.name,
    mappings,
    lifecycle: lifecycleConfig,
    runtime: "codex",
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

// ── Config writing (used by tenant.ts via import) ─────────────────────────────

type WriteConfigInput = {
  tenantId: string;
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
