import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseWorkflowMarkdown } from "@gh-symphony/core";
import {
  getProcessIdentity,
  isProcessRunning,
  getSupportedTrackerKinds,
  resolveWorkflowConfigTrackerAdapter,
  createStore,
} from "@gh-symphony/orchestrator";
import {
  CliProcess,
  LocalLifecycleAdapter,
  LocalReadAdapter,
  projectEnvironment,
  type AgentRegistry,
  type CliProcessOptions,
  type RegisteredProject,
  type RuntimeInspection,
  type RuntimeDriver,
  type StopTarget,
} from "@gh-symphony/management-agent";
import { LIMITS } from "@gh-symphony/management-protocol";
import { inspectExpectedStopTarget } from "./expected-stop.js";
import { daemonPidPath, projectConfigDir } from "./config.js";
import { resolveCanonicalRuntime } from "./local-project-runtime.js";
export { AgentRegistry } from "@gh-symphony/management-agent";
export type {
  StopTarget,
  StopTargetJournal,
  LifecycleResult,
  LocalInventory,
} from "@gh-symphony/management-agent";
export { resolveCanonicalRuntime } from "./local-project-runtime.js";
export type { CanonicalRuntime } from "./local-project-runtime.js";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Read local state without refreshing configuration, making effects, or uploading raw snapshots. */
export async function inspectLocalProject(
  configDir: string,
  project: RegisteredProject,
  environment = process.env
): Promise<RuntimeInspection> {
  const observedAt = new Date().toISOString();
  const observed: RuntimeInspection = {
    validation: {
      state: "invalid",
      diagnostic: {
        code: "project_invalid",
        message: "Workflow unavailable or invalid; inspect locally",
      },
    },
    process: {
      state: "unknown",
      observedAt,
      diagnostic: {
        code: "process_unverified",
        message: "Runtime ownership cannot be verified",
      },
    },
    runs: [],
    ready: false,
    locksReleased: false,
  };
  try {
    const workflowPath = join(project.canonicalPath, "WORKFLOW.md");
    const markdown = await readFile(workflowPath, "utf8");
    const workflow = parseWorkflowMarkdown(markdown, environment, {
      supportedTrackerKinds: getSupportedTrackerKinds(),
      resolveTrackerAdapter: resolveWorkflowConfigTrackerAdapter,
      workflowPath,
    });
    const repository = workflow.repository?.slug;
    const bindingId =
      workflow.tracker.projectId ?? workflow.tracker.projectSlug;
    if (
      !workflow.tracker.kind ||
      !bindingId ||
      typeof repository !== "string" ||
      !/^[^/]+\/[^/]+$/.test(repository)
    )
      throw new Error("Invalid standalone workflow");
    observed.validation = { state: "valid" };
    observed.metadata = {
      workflowRevision: createHash("sha256").update(markdown).digest("hex"),
      trackerScope: {
        adapter: workflow.tracker.kind,
        bindingId,
        repository,
        activeStates: [...workflow.tracker.activeStates],
        includeLabels: [...workflow.tracker.pickupLabels.include],
        excludeLabels: [...workflow.tracker.pickupLabels.exclude],
      },
    };
  } catch {
    /* Keep invalid workflow visible with a safe diagnostic. */
  }
  try {
    const runtime = await resolveCanonicalRuntime(
      configDir,
      project.canonicalPath
    );
    const folderLock = join(project.canonicalPath, ".gh-symphony-start.lock");
    if (!runtime) {
      observed.locksReleased = !(await exists(folderLock));
      if (observed.locksReleased)
        observed.process = { state: "stopped", observedAt };
      return observed;
    }
    observed.runtime = {
      configDir: runtime.configDir,
      runtimeProjectId: runtime.runtimeProjectId,
    };
    const lockPath = join(
      runtime.configDir,
      "projects",
      runtime.runtimeProjectId,
      ".lock"
    );
    observed.locksReleased =
      !(await exists(folderLock)) && !(await exists(lockPath));
    const pidPath = daemonPidPath(runtime.configDir, runtime.runtimeProjectId);
    const records: { pid: number; processIdentity: string }[] = [];
    for (const path of [pidPath, lockPath, folderLock]) {
      try {
        const record = JSON.parse(await readFile(path, "utf8")) as {
          pid?: unknown;
          processIdentity?: unknown;
        };
        if (
          !Number.isSafeInteger(record.pid) ||
          Number(record.pid) <= 0 ||
          typeof record.processIdentity !== "string" ||
          !record.processIdentity
        )
          return observed;
        records.push({
          pid: Number(record.pid),
          processIdentity: record.processIdentity,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return observed;
      }
    }
    const target = records[0];
    if (target) {
      const result = inspectExpectedStopTarget(
        {
          configDir: runtime.configDir,
          projectId: runtime.runtimeProjectId,
          projectDir: project.canonicalPath,
        },
        target
      );
      if (result === "verified") {
        observed.process = {
          state: "running",
          observedAt,
          pid: target.pid,
          identity: target.processIdentity,
        };
        // Daemon PID is published only after the CLI readiness signal. Lock-only
        // foreground ownership is running, but cannot prove startup readiness.
        observed.ready = await exists(pidPath);
      } else if (result === "already_stopped" && observed.locksReleased)
        observed.process = { state: "stopped", observedAt };
    } else if (observed.locksReleased)
      observed.process = { state: "stopped", observedAt };
    try {
      const runs = await createStore(runtime.configDir).loadRuns({
        projectId: runtime.runtimeProjectId,
      });
      observed.runs = runs
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, LIMITS.runSummariesPerProject)
        .map((run) => ({
          runId: run.runId,
          status: run.status,
          startedAt: run.startedAt ?? run.createdAt,
          updatedAt: run.updatedAt,
        }));
    } catch {
      /* Unavailable history does not authorize effects. */
    }
    return observed;
  } catch {
    return observed;
  }
}

export interface IsolatedProjectLaunch {
  executable: string;
  args: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  deadline: number;
}
/** Implemented by the native service slice, with independently verified OS isolation. */
export type ProjectLaunchContext =
  | { kind: "foreground" }
  | {
      kind: "native-service";
      launchIsolatedProject: (
        request: IsolatedProjectLaunch
      ) => Promise<{ exitCode: number | null }>;
    };
export type LocalManagementOptions = CliProcessOptions & {
  configDir: string;
  pollIntervalMs?: number;
  launchContext: ProjectLaunchContext;
};

export function createLocalManagementAdapter(
  registry: AgentRegistry,
  options: LocalManagementOptions
): { adapter: LocalLifecycleAdapter; reader: RuntimeDriver } {
  if (
    !options.launchContext ||
    (options.launchContext.kind !== "foreground" &&
      options.launchContext.kind !== "native-service") ||
    (options.launchContext.kind === "native-service" &&
      typeof options.launchContext.launchIsolatedProject !== "function")
  ) {
    throw new Error(
      "Native-service management requires an explicit isolated project launcher; detached CLI spawning is insufficient"
    );
  }
  const credentials = [
    ...(options.managementCredentials ?? []),
    ...(registry.identity ? [registry.identity.credential] : []),
  ];
  const environment = projectEnvironment(
    options.environment ?? process.env,
    credentials
  );
  const cli = new CliProcess({
    ...options,
    environment,
    managementCredentials: credentials,
  });
  const configDir = resolve(options.configDir);
  const reader: RuntimeDriver = {
    inspect: (project) => inspectLocalProject(configDir, project, environment),
    start: async (project, deadline) => {
      const runtime = await resolveCanonicalRuntime(
        configDir,
        project.canonicalPath
      );
      const launchPath = runtime?.project.projectDir ?? project.canonicalPath;
      if (
        (await realpath(launchPath).catch(() => null)) !== project.canonicalPath
      )
        throw new Error(
          "Cached runtime path no longer addresses the registered canonical folder"
        );
      const args = [
        "--config",
        runtime?.configDir ?? configDir,
        "--json",
        "project",
        "start",
        "--project-dir",
        launchPath,
        "--daemon",
      ];
      return options.launchContext.kind === "native-service"
        ? options.launchContext.launchIsolatedProject({
            executable: options.executable,
            args: [...(options.argumentPrefix ?? []), ...args],
            cwd: project.canonicalPath,
            environment: { ...environment },
            deadline,
          })
        : cli.run(args, project.canonicalPath, deadline);
    },
    stop: (project, target, deadline) =>
      cli.run(
        [
          "--config",
          target.configDir,
          "--json",
          "project",
          "stop",
          "--project-dir",
          project.canonicalPath,
          "--expected-pid",
          String(target.pid),
          "--expected-process-identity",
          target.processIdentity,
        ],
        project.canonicalPath,
        deadline
      ),
    async targetExited(target: StopTarget) {
      if (!isProcessRunning(target.pid)) return true;
      const identity = getProcessIdentity(target.pid);
      return identity !== null && identity !== target.processIdentity;
    },
  };
  return {
    adapter: new LocalLifecycleAdapter(registry, reader, options),
    reader,
  };
}

/** Separate on-demand read lane; canonical runtime ownership stays in the CLI. */
export function createLocalReadAdapter(
  registry: AgentRegistry,
  configDir: string
): LocalReadAdapter {
  return new LocalReadAdapter(registry, async (project) => {
    const runtime = await resolveCanonicalRuntime(
      configDir,
      project.canonicalPath
    );
    if (!runtime) return null;
    return {
      projectDirectory: projectConfigDir(
        await realpath(runtime.configDir),
        runtime.runtimeProjectId
      ),
      runtimeProjectId: runtime.runtimeProjectId,
    };
  });
}
