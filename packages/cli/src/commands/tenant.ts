import * as p from "@clack/prompts";
import type { GlobalOptions } from "../index.js";
import {
  createClient,
  validateToken,
  checkRequiredScopes,
  listUserProjects,
  getProjectDetail,
  type GitHubClient,
  type ViewerInfo,
  type ProjectSummary,
  type ProjectDetail,
} from "../github/client.js";
import {
  inferAllStateRoles,
  toWorkflowLifecycleConfig,
  validateStateMapping,
} from "../mapping/smart-defaults.js";
import {
  loadGlobalConfig,
  saveGlobalConfig,
  loadTenantConfig,
  tenantConfigDir,
  type CliGlobalConfig,
  type StateRole,
  type StateMapping,
} from "../config.js";
import { writeConfig, generateTenantId, abortIfCancelled } from "./init.js";

// ── Non-interactive flag parsing ─────────────────────────────────────────────

type TenantAddFlags = {
  nonInteractive: boolean;
  token?: string;
  project?: string;
  runtime?: string;
};

function parseTenantAddFlags(args: string[]): TenantAddFlags {
  const flags: TenantAddFlags = { nonInteractive: false };

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
      case "--runtime":
        flags.runtime = next;
        i += 1;
        break;
    }
  }

  return flags;
}

// ── Tenant command handler ────────────────────────────────────────────────────

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => {
  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case "add":
      await tenantAdd(rest, options);
      return;
    case "list":
      await tenantList(options);
      return;
    case "remove":
      await tenantRemove(rest, options);
      return;
    default:
      process.stdout.write(
        "Usage: gh-symphony tenant <add|list|remove>\n"
      );
  }
};

export default handler;

// ── tenant add ───────────────────────────────────────────────────────────────

async function tenantAdd(
  args: string[],
  options: GlobalOptions
): Promise<void> {
  const flags = parseTenantAddFlags(args);

  if (flags.nonInteractive) {
    await tenantAddNonInteractive(flags, options);
    return;
  }

  await tenantAddInteractive(options);
}

// ── Non-interactive tenant add ───────────────────────────────────────────────

async function tenantAddNonInteractive(
  flags: TenantAddFlags,
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
      (p) => p.id === flags.project || p.url === flags.project
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

  const runtime = flags.runtime ?? "codex";
  const tenantId = generateTenantId(project.title, project.id);

  await writeConfig(options.configDir, {
    tenantId,
    token: flags.token,
    project,
    repos: project.linkedRepositories,
    statusField,
    mappings,
    runtime,
  });

  if (options.json) {
    process.stdout.write(
      JSON.stringify({ tenantId, status: "created" }) + "\n"
    );
  } else {
    process.stdout.write(`Tenant created: ${tenantId}\n`);
    process.stdout.write(`Run 'gh-symphony start' to begin orchestration.\n`);
  }
}

// ── Interactive tenant add ───────────────────────────────────────────────────

async function tenantAddInteractive(options: GlobalOptions): Promise<void> {
  p.intro("gh-symphony — Tenant Setup");

  // Detect existing config
  const existingConfig = await loadGlobalConfig(options.configDir);
  if (existingConfig) {
    const action = await abortIfCancelled(
      p.select({
        message: "Existing configuration detected. What would you like to do?",
        options: [
          { value: "add", label: "Add a new tenant" },
          { value: "overwrite", label: "Start fresh (overwrite)" },
        ],
      })
    );
    if (action === "overwrite") {
      // Continue with fresh setup — will overwrite config
    }
    // "add" continues to create a new tenant alongside existing ones
  }

  // ── Step 1: PAT input with async validation ────────────────────────────────
  let token: string;
  let viewer: ViewerInfo;
  let client: GitHubClient;

  while (true) {
    const rawToken = await abortIfCancelled(
      p.password({
        message: "Step 1/6 — Enter your GitHub Personal Access Token:",
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
      viewer = await validateToken(client);
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
      token = rawToken;
      break;
    } catch (error) {
      s.stop(
        `Token invalid: ${error instanceof Error ? error.message : "Unknown error"}`
      );
      p.log.warn("Please try a different token.");
    }
  }

  // ── Step 2: Project selection ───────────────────────────────────────────────

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
      message: "Step 2/6 — Select a GitHub Project:",
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

  // ── Step 3: Repository selection ────────────────────────────────────────────

  if (projectDetail.linkedRepositories.length === 0) {
    p.log.warn(
      "No linked repositories found in this project. Add issues from repositories to the project first."
    );
    process.exitCode = 1;
    return;
  }

  const selectedRepos = await abortIfCancelled(
    p.multiselect({
      message: "Step 3/6 — Select repositories to orchestrate:",
      options: projectDetail.linkedRepositories.map((repo) => ({
        value: repo,
        label: `${repo.owner}/${repo.name}`,
      })),
      required: true,
    })
  );

  // ── Step 4: Status column mapping ───────────────────────────────────────────

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

  // Show smart defaults and let user adjust
  const mappings: Record<string, StateMapping> = {};
  for (const mapping of inferred) {
    const roleOptions: Array<{ value: StateRole | "skip"; label: string }> = [
      { value: "active", label: "Active (agent works on this)" },
      { value: "wait", label: "Wait (human review / hold)" },
      { value: "terminal", label: "Terminal (completed)" },
    ];

    const defaultRole = mapping.role ?? "wait";
    // Put default first
    const sortedOptions = [
      roleOptions.find((o) => o.value === defaultRole)!,
      ...roleOptions.filter((o) => o.value !== defaultRole),
    ];

    const selectedRole = await abortIfCancelled(
      p.select({
        message: `Step 4/6 — Map column "${mapping.columnName}":${mapping.confidence === "high" ? " (auto-detected)" : ""}`,
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

  // Show visual flow summary
  const lifecycleConfig = toWorkflowLifecycleConfig(
    statusField.name,
    mappings
  );

  const flowParts: string[] = [];
  if (lifecycleConfig.activeStates.length)
    flowParts.push(`[Active: ${lifecycleConfig.activeStates.join(", ")}]`);
  if (lifecycleConfig.terminalStates.length)
    flowParts.push(`[Terminal: ${lifecycleConfig.terminalStates.join(", ")}]`);

  p.note(flowParts.join(" → "), "Workflow Flow");

  // ── Step 5: Runtime selection ────────────────────────────────────────────────

  const runtime = await abortIfCancelled(
    p.select({
      message: "Step 5/6 — Select AI runtime:",
      options: [
        { value: "codex", label: "OpenAI Codex", hint: "recommended" },
        { value: "claude-code", label: "Claude Code" },
        { value: "custom", label: "Custom command" },
      ],
    })
  );

  let workerCommand: string | undefined;
  if (runtime === "custom") {
    workerCommand = await abortIfCancelled(
      p.text({
        message: "Custom worker command:",
        placeholder: "node packages/worker/dist/index.js",
      })
    );
  }

  // ── Step 6: Advanced options ─────────────────────────────────────────────────

  const advancedOptions = await abortIfCancelled(
    p.confirm({
      message:
        "Step 6/6 — Configure advanced options? (poll interval, concurrency)",
      initialValue: false,
    })
  );

  let pollIntervalMs = 30_000;
  let concurrency = 3;
  let maxAttempts = 3;

  if (advancedOptions) {
    const pollStr = await abortIfCancelled(
      p.text({
        message: "Poll interval (seconds):",
        placeholder: "30",
        initialValue: "30",
        validate: (v) => {
          const n = Number(v);
          if (!v || isNaN(n) || n < 5) return "Must be at least 5 seconds.";
        },
      })
    );
    pollIntervalMs = Number(pollStr) * 1000;

    const concurrencyStr = await abortIfCancelled(
      p.text({
        message: "Max concurrent workers:",
        placeholder: "3",
        initialValue: "3",
        validate: (v) => {
          const n = Number(v);
          if (!v || isNaN(n) || n < 1) return "Must be at least 1.";
        },
      })
    );
    concurrency = Number(concurrencyStr);

    const attemptsStr = await abortIfCancelled(
      p.text({
        message: "Max retry attempts per issue:",
        placeholder: "3",
        initialValue: "3",
        validate: (v) => {
          const n = Number(v);
          if (!v || isNaN(n) || n < 1) return "Must be at least 1.";
        },
      })
    );
    maxAttempts = Number(attemptsStr);
  }

  // ── Confirmation ─────────────────────────────────────────────────────────────

  p.note(
    [
      `User:       ${viewer.login}`,
      `Project:    ${projectDetail.title}`,
      `Repos:      ${selectedRepos.map((r) => `${r.owner}/${r.name}`).join(", ")}`,
      `Runtime:    ${runtime}`,
      `Active:     ${lifecycleConfig.activeStates.join(", ")}`,
      `Terminal:   ${lifecycleConfig.terminalStates.join(", ")}`,
      `Poll:       ${pollIntervalMs / 1000}s`,
      `Concurrency: ${concurrency}`,
      `Max retries: ${maxAttempts}`,
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

  // ── Write config files ────────────────────────────────────────────────────────

  const tenantId = generateTenantId(projectDetail.title, projectDetail.id);

  const s6 = p.spinner();
  s6.start("Writing configuration...");

  try {
    await writeConfig(options.configDir, {
      tenantId,
      token,
      project: projectDetail,
      repos: selectedRepos,
      statusField: {
        name: statusField.name,
        options: statusField.options,
      },
      mappings,
      runtime,
      workerCommand,
      pollIntervalMs,
      concurrency,
      maxAttempts,
    });
    s6.stop("Configuration saved.");
  } catch (error) {
    s6.stop("Failed to write configuration.");
    p.log.error(error instanceof Error ? error.message : "Unknown error");
    process.exitCode = 1;
    return;
  }

  p.log.info(
    `WORKFLOW.md generated at ${tenantId}/WORKFLOW.md — edit it to customize your team policy.`
  );
  p.outro(
    `Tenant "${tenantId}" created!\n  Run 'gh-symphony start' to begin orchestration.`
  );
}

// ── tenant list ───────────────────────────────────────────────────────────────

async function tenantList(options: GlobalOptions): Promise<void> {
  const global = await loadGlobalConfig(options.configDir);
  if (!global?.tenants?.length) {
    process.stdout.write("No tenants configured.\n");
    return;
  }

  process.stdout.write("Configured tenants:\n");
  const configs = await Promise.all(
    global.tenants.map((id) => loadTenantConfig(options.configDir, id))
  );
  for (let i = 0; i < global.tenants.length; i++) {
    const tenantId = global.tenants[i]!;
    const config = configs[i];
    const active = global.activeTenant === tenantId ? " (active)" : "";
    const slug = config?.slug ?? tenantId;
    process.stdout.write(`  ${slug}${active}\n`);
  }
}

// ── tenant remove ─────────────────────────────────────────────────────────────

async function tenantRemove(
  args: string[],
  options: GlobalOptions
): Promise<void> {
  const tenantId = args[0];
  if (!tenantId) {
    process.stderr.write("Usage: gh-symphony tenant remove <tenant-id>\n");
    process.exitCode = 1;
    return;
  }

  const global = await loadGlobalConfig(options.configDir);
  if (!global) {
    process.stderr.write("No configuration found.\n");
    process.exitCode = 1;
    return;
  }

  const updatedTenants = (global.tenants ?? []).filter((t) => t !== tenantId);
  if (updatedTenants.length === global.tenants.length) {
    process.stderr.write(`Tenant "${tenantId}" not found.\n`);
    process.exitCode = 1;
    return;
  }

  const updatedConfig: CliGlobalConfig = {
    ...global,
    tenants: updatedTenants,
    activeTenant: global.activeTenant === tenantId ? null : global.activeTenant,
  };
  await saveGlobalConfig(options.configDir, updatedConfig);

  const { rm } = await import("node:fs/promises");
  const dir = tenantConfigDir(options.configDir, tenantId);
  try {
    await rm(dir, { recursive: true, force: true });
  } catch {
    // Directory may not exist
  }

  process.stdout.write(`Tenant "${tenantId}" removed.\n`);
}
