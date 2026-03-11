import * as p from "@clack/prompts";
import { createHash } from "node:crypto";
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
  type LinkedRepository,
} from "../github/client.js";
import {
  inferAllColumnRoles,
  toWorkflowLifecycleConfig,
  validateMapping,
} from "../mapping/smart-defaults.js";
import {
  loadGlobalConfig,
  saveGlobalConfig,
  saveWorkspaceConfig,
  saveWorkflowMapping,
  type CliGlobalConfig,
  type CliWorkspaceConfig,
  type ColumnRole,
  type HumanReviewMode,
  type WorkflowMappingConfig,
} from "../config.js";
import type { WorkflowLifecycleConfig } from "@gh-symphony/core";

// ── Cancellation utility ─────────────────────────────────────────────────────

async function abortIfCancelled<T>(
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

type NonInteractiveFlags = {
  nonInteractive: boolean;
  token?: string;
  project?: string;
  runtime?: string;
};

function parseInitFlags(args: string[]): NonInteractiveFlags {
  const flags: NonInteractiveFlags = { nonInteractive: false };

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

// ── 4.8: Non-interactive mode ────────────────────────────────────────────────

async function runNonInteractive(
  flags: NonInteractiveFlags,
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
  const inferred = inferAllColumnRoles(columnNames);
  const roles: Record<string, ColumnRole> = {};
  for (const mapping of inferred) {
    if (mapping.role) {
      roles[mapping.columnName] = mapping.role;
    }
  }

  const validation = validateMapping(roles);
  if (!validation.valid) {
    process.stderr.write(
      `Error: Cannot auto-map columns. ${validation.errors.join("; ")}\nRun without --non-interactive for manual mapping.\n`
    );
    process.exitCode = 1;
    return;
  }

  const runtime = flags.runtime ?? "codex";
  const workspaceId = generateWorkspaceId(project.title, project.id);

  await writeConfig(options.configDir, {
    workspaceId,
    token: flags.token,
    project,
    repos: project.linkedRepositories,
    statusField,
    roles,
    humanReviewMode: "plan-and-pr",
    runtime,
  });

  if (options.json) {
    process.stdout.write(
      JSON.stringify({ workspaceId, status: "created" }) + "\n"
    );
  } else {
    process.stdout.write(`Workspace created: ${workspaceId}\n`);
    process.stdout.write(`Run 'gh-symphony start' to begin orchestration.\n`);
  }
}

// ── Interactive mode ─────────────────────────────────────────────────────────

async function runInteractive(options: GlobalOptions): Promise<void> {
  p.intro("gh-symphony — Workspace Setup");

  // 4.7: Detect existing config
  const existingConfig = await loadGlobalConfig(options.configDir);
  if (existingConfig) {
    const action = await abortIfCancelled(
      p.select({
        message: "Existing configuration detected. What would you like to do?",
        options: [
          { value: "add", label: "Add a new workspace" },
          { value: "overwrite", label: "Start fresh (overwrite)" },
        ],
      })
    );
    if (action === "overwrite") {
      // Continue with fresh setup — will overwrite config
    }
    // "add" continues to create a new workspace alongside existing ones
  }

  // ── Step 1: PAT input with async validation (4.1) ─────────────────────────
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

  // ── Step 2: Project selection (4.2) ────────────────────────────────────────

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
      "No GitHub Projects found. Create a project at https://github.com/orgs/YOUR_ORG/projects and re-run init."
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

  // ── Step 3: Repository selection (4.3) ─────────────────────────────────────

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

  // ── Step 4: Status column mapping (4.4) ────────────────────────────────────

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
  const inferred = inferAllColumnRoles(columnNames);

  p.log.info(
    `Found ${columnNames.length} status columns on field "${statusField.name}".`
  );

  // Show smart defaults and let user adjust
  const roles: Record<string, ColumnRole> = {};
  for (const mapping of inferred) {
    const roleOptions: Array<{ value: ColumnRole | "skip"; label: string }> = [
      { value: "trigger", label: "Trigger (starts work)" },
      { value: "working", label: "Working (implementation)" },
      { value: "human-review", label: "Review (human approval)" },
      { value: "done", label: "Done (completed)" },
      { value: "ignored", label: "Ignored (skip)" },
    ];

    const defaultRole = mapping.role ?? "ignored";
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
      roles[mapping.columnName] = selectedRole as ColumnRole;
    }
  }

  const validation = validateMapping(roles);
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

  // Human review mode selection
  const humanReviewMode = await abortIfCancelled(
    p.select<HumanReviewMode>({
      message: "Human review mode:",
      options: [
        {
          value: "plan-and-pr" as HumanReviewMode,
          label: "Plan & PR review",
          hint: "Human reviews both plans and PRs",
        },
        {
          value: "plan-only" as HumanReviewMode,
          label: "Plan review only",
          hint: "Human reviews plans, PRs auto-merge",
        },
        {
          value: "pr-only" as HumanReviewMode,
          label: "PR review only",
          hint: "No plan review, human reviews PRs",
        },
        {
          value: "none" as HumanReviewMode,
          label: "None (full auto)",
          hint: "No human review at all",
        },
      ],
    })
  );

  // Show visual flow summary
  const lifecycleConfig = toWorkflowLifecycleConfig(
    statusField.name,
    roles,
    humanReviewMode
  );

  const flowParts: string[] = [];
  if (lifecycleConfig.planningStates.length)
    flowParts.push(`[Planning: ${lifecycleConfig.planningStates.join(", ")}]`);
  if (lifecycleConfig.humanReviewStates.length)
    flowParts.push(`[Review: ${lifecycleConfig.humanReviewStates.join(", ")}]`);
  if (lifecycleConfig.implementationStates.length)
    flowParts.push(
      `[Implementation: ${lifecycleConfig.implementationStates.join(", ")}]`
    );
  if (lifecycleConfig.awaitingMergeStates.length)
    flowParts.push(
      `[Awaiting Merge: ${lifecycleConfig.awaitingMergeStates.join(", ")}]`
    );
  if (lifecycleConfig.completedStates.length)
    flowParts.push(`[Done: ${lifecycleConfig.completedStates.join(", ")}]`);

  p.note(flowParts.join(" → "), "Workflow Flow");

  // ── Step 5: Runtime selection (4.5) ────────────────────────────────────────

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

  // ── Step 6: Options (4.5) ──────────────────────────────────────────────────

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

  // ── Confirmation ───────────────────────────────────────────────────────────

  p.note(
    [
      `User:       ${viewer.login}`,
      `Project:    ${projectDetail.title}`,
      `Repos:      ${selectedRepos.map((r) => `${r.owner}/${r.name}`).join(", ")}`,
      `Runtime:    ${runtime}`,
      `Review:     ${humanReviewMode}`,
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

  // ── Write config files (4.6) ───────────────────────────────────────────────

  const workspaceId = generateWorkspaceId(projectDetail.title, projectDetail.id);

  const s6 = p.spinner();
  s6.start("Writing configuration...");

  try {
    await writeConfig(options.configDir, {
      workspaceId,
      token,
      project: projectDetail,
      repos: selectedRepos,
      statusField: {
        name: statusField.name,
        options: statusField.options,
      },
      roles,
      humanReviewMode,
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

  p.outro(
    `Workspace "${workspaceId}" created!\n  Run 'gh-symphony start' to begin orchestration.`
  );
}

// ── Config writing (4.6) ─────────────────────────────────────────────────────

type WriteConfigInput = {
  workspaceId: string;
  token: string;
  project: ProjectDetail;
  repos: LinkedRepository[];
  statusField: { name: string; options: Array<{ name: string }> };
  roles: Record<string, ColumnRole>;
  humanReviewMode: HumanReviewMode;
  runtime: string;
  workerCommand?: string;
  pollIntervalMs?: number;
  concurrency?: number;
  maxAttempts?: number;
};

export async function writeConfig(
  configDir: string,
  input: WriteConfigInput
): Promise<void> {
  const lifecycleConfig = toWorkflowLifecycleConfig(
    input.statusField.name,
    input.roles,
    input.humanReviewMode
  );

  // Save workflow mapping
  const mappingConfig: WorkflowMappingConfig = {
    stateFieldName: input.statusField.name,
    columnRoles: input.roles,
    humanReviewMode: input.humanReviewMode,
    lifecycle: lifecycleConfig,
  };
  await saveWorkflowMapping(configDir, input.workspaceId, mappingConfig);

  // Save workspace config (OrchestratorWorkspaceConfig shape)
  const runtimeDir = `${configDir}/workspaces/${input.workspaceId}/runtime`;
  await saveWorkspaceConfig(configDir, input.workspaceId, {
    workspaceId: input.workspaceId,
    slug: input.workspaceId,
    promptGuidelines: "",
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
      },
    },
    runtime: {
      driver: "local",
      workspaceRuntimeDir: runtimeDir,
      projectRoot: process.cwd(),
      workerCommand: input.workerCommand,
    },
    workflow: buildWorkflowOverrides(lifecycleConfig, input),
    orchestrator: {
      concurrency: input.concurrency,
      maxAttempts: input.maxAttempts,
    },
    workflowMapping: mappingConfig,
  });

  // Save/update global config
  const existing = await loadGlobalConfig(configDir);
  const globalConfig: CliGlobalConfig = {
    activeWorkspace: input.workspaceId,
    token: input.token,
    workspaces: [
      ...(existing?.workspaces ?? []).filter((w) => w !== input.workspaceId),
      input.workspaceId,
    ],
  };
  await saveGlobalConfig(configDir, globalConfig);
}

function buildWorkflowOverrides(
  lifecycle: WorkflowLifecycleConfig,
  input: WriteConfigInput
): NonNullable<CliWorkspaceConfig["workflow"]> {
  return {
    lifecycle,
    scheduler: {
      pollIntervalMs: input.pollIntervalMs ?? 30_000,
    },
  };
}

export function generateWorkspaceId(
  projectTitle: string,
  uniqueKey: string
): string {
  const slug = projectTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
  const suffix = createHash("sha1").update(uniqueKey).digest("hex").slice(0, 8);
  return [slug || "workspace", suffix].join("-");
}
