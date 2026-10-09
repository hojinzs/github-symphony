import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { LIMITS } from "@gh-symphony/management-protocol";
import type {
  Diagnostic,
  ProcessObservation,
  ProjectValidation,
  RunSummary,
} from "@gh-symphony/management-protocol";
import type {
  AgentRegistry,
  RegisteredProject,
  LocalProjectMetadata,
} from "./registry.js";
export interface RuntimeBinding {
  configDir: string;
  runtimeProjectId: string;
}
export interface StopTarget extends RuntimeBinding {
  canonicalPath: string;
  pid: number;
  processIdentity: string;
}
export interface RuntimeInspection {
  validation: ProjectValidation;
  process: ProcessObservation;
  runs: RunSummary[];
  metadata?: LocalProjectMetadata;
  runtime?: RuntimeBinding;
  ready: boolean;
  locksReleased: boolean;
}
export interface RuntimeDriver {
  inspect(project: RegisteredProject): Promise<RuntimeInspection>;
  start(
    project: RegisteredProject,
    deadline: number
  ): Promise<{ exitCode: number | null }>;
  stop(
    project: RegisteredProject,
    target: StopTarget,
    deadline: number
  ): Promise<{ exitCode: number | null; outcome?: string }>;
  targetExited(target: StopTarget): Promise<boolean>;
}
/** The consumer must durably commit this target before acknowledging persistence. */
export interface StopTargetJournal {
  persistStopTarget(target: StopTarget): Promise<void>;
}
export interface LifecycleResult {
  state: "succeeded" | "failed" | "unknown";
  process: ProcessObservation;
  diagnostic?: Diagnostic;
}
export class LocalLifecycleAdapter {
  private readonly pending = new Map<string, Promise<unknown>>();
  constructor(
    private registry: AgentRegistry,
    private driver: RuntimeDriver,
    private options: { timeoutMs?: number; pollIntervalMs?: number } = {}
  ) {}

  start(id: string): Promise<LifecycleResult> {
    return this.serialize(id, async () => {
      const deadline = Date.now() + this.timeoutMs();
      const project = await this.registry.resolveManaged(id);
      const observed = await this.driver.inspect(project);
      if (observed.validation.state === "invalid")
        return failure(
          observed,
          "project_invalid",
          "Workflow invalid; inspect the project locally before starting"
        );
      if (observed.process.state === "unknown")
        return failure(
          observed,
          "process_unverified",
          "Process ownership cannot be verified"
        );
      if (observed.process.state === "running" && observed.ready)
        return success(observed);
      if (observed.process.state === "running" || !observed.locksReleased)
        return failure(
          observed,
          "process_unverified",
          "Project ownership or readiness is uncertain"
        );
      await this.registry.resolveManaged(id);
      const invocation = await this.driver.start(project, deadline);
      const result = await this.wait(
        project,
        (current) => current.process.state === "running" && current.ready,
        undefined,
        deadline
      );
      if (result) return result;
      const current = await this.driver.inspect(project);
      return invocation.exitCode === null || invocation.exitCode === 0
        ? unresolved(current)
        : failure(
            current,
            "project_invalid",
            "CLI start failed; inspect workflow, credentials and overlap checks locally with project start"
          );
    });
  }

  stop(
    id: string,
    journal: StopTargetJournal,
    expected?: StopTarget
  ): Promise<LifecycleResult> {
    return this.serialize(id, async () => {
      const deadline = Date.now() + this.timeoutMs();
      const project = await this.registry.resolveManaged(id);
      const observed = await this.driver.inspect(project);
      if (expected && expected.canonicalPath !== project.canonicalPath)
        return failure(
          observed,
          "superseded_target",
          "Journaled folder does not match registration"
        );
      if (observed.process.state === "unknown")
        return failure(
          observed,
          "process_unverified",
          "Process ownership cannot be verified"
        );
      if (observed.process.state === "stopped") {
        if (
          observed.locksReleased &&
          (!expected || (await this.driver.targetExited(expected)))
        )
          return success(observed);
        return unresolved(observed);
      }
      if (!observed.runtime)
        return failure(
          observed,
          "process_unverified",
          "Runtime identity unavailable"
        );
      const currentTarget: StopTarget = {
        ...observed.runtime,
        canonicalPath: project.canonicalPath,
        pid: observed.process.pid,
        processIdentity: observed.process.identity,
      };
      if (expected && !sameTarget(expected, currentTarget))
        return failure(
          observed,
          "superseded_target",
          "Journaled target has been replaced; no signal sent"
        );
      const target = expected ?? currentTarget;
      await journal.persistStopTarget(target);
      // The journal consumer owns command claims/replay. Never select a fresh
      // target on recovery or fall back to folder-only shutdown.
      const invocation = await this.driver.stop(project, target, deadline);
      if (invocation.outcome === "superseded_target")
        return failure(
          await this.driver.inspect(project),
          "superseded_target",
          "Expected target replaced; no replacement signal sent"
        );
      if (
        invocation.outcome !== "signal_sent" &&
        invocation.outcome !== "already_stopped"
      )
        return unresolved(await this.driver.inspect(project));
      const result = await this.wait(
        project,
        async (current) =>
          current.process.state === "stopped" &&
          current.locksReleased &&
          (await this.driver.targetExited(target)),
        target,
        deadline
      );
      return result ?? unresolved(await this.driver.inspect(project));
    });
  }

  private async wait(
    project: RegisteredProject,
    completed: (current: RuntimeInspection) => boolean | Promise<boolean>,
    target?: StopTarget,
    deadline = Date.now() + this.timeoutMs()
  ): Promise<LifecycleResult | null> {
    do {
      const current = await this.driver.inspect(project);
      if (
        target &&
        current.process.state === "running" &&
        (current.process.pid !== target.pid ||
          current.process.identity !== target.processIdentity)
      )
        return failure(
          current,
          "superseded_target",
          "Replacement process observed; stop cannot claim completion"
        );
      if (await completed(current)) return success(current);
      await delay(
        Math.min(
          this.options.pollIntervalMs ?? 100,
          Math.max(0, deadline - Date.now())
        )
      );
    } while (Date.now() < deadline);
    return null;
  }
  private timeoutMs(): number {
    return Math.max(
      1,
      Math.min(
        this.options.timeoutMs ?? LIMITS.executionObservationTimeoutMs,
        LIMITS.executionObservationTimeoutMs
      )
    );
  }
  private serialize(
    id: string,
    action: () => Promise<LifecycleResult>
  ): Promise<LifecycleResult> {
    const previous = this.pending.get(id) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    this.pending.set(id, current);
    void current
      .finally(() => {
        if (this.pending.get(id) === current) this.pending.delete(id);
      })
      .catch(() => {});
    return current;
  }
}
function sameTarget(left: StopTarget, right: StopTarget): boolean {
  return (
    left.canonicalPath === right.canonicalPath &&
    left.configDir === right.configDir &&
    left.runtimeProjectId === right.runtimeProjectId &&
    left.pid === right.pid &&
    left.processIdentity === right.processIdentity
  );
}
function success(current: RuntimeInspection): LifecycleResult {
  return { state: "succeeded", process: publicProcess(current.process) };
}
function failure(
  current: RuntimeInspection,
  code: Diagnostic["code"],
  message: string
): LifecycleResult {
  return {
    state: "failed",
    process: publicProcess(current.process),
    diagnostic: { code, message },
  };
}
function unresolved(current: RuntimeInspection): LifecycleResult {
  return {
    state: "unknown",
    process: publicProcess(current.process),
    diagnostic: {
      code: "unresolved_command",
      message:
        "CLI effect could not be confirmed within the observation deadline; inspect locally without blind replay",
    },
  };
}

function publicProcess(process: ProcessObservation): ProcessObservation {
  return process.state === "running"
    ? {
        state: "running",
        pid: process.pid,
        observedAt: process.observedAt,
        identity: createHash("sha256").update(process.identity).digest("hex"),
      }
    : process;
}
