import type { JsonValue } from "@gh-symphony/management-protocol";
import type { ObservedProject } from "./observations.js";

function record(value: JsonValue | undefined): Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : {};
}
function count(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/** Presentation only: command services must independently authorize every action. */
export function presentProject(project: ObservedProject) {
  const observation = project.observation;
  const snapshot = record(observation.snapshot);
  const summary = record(snapshot.summary);
  const historical =
    !project.managed || !project.fresh || project.connection !== "online";
  const snapshotHistorical = historical || project.snapshotStale;
  const diagnostic =
    observation.validation.state === "invalid"
      ? observation.validation.diagnostic
      : undefined;
  const unavailable = !project.managed
    ? "Project is unmanaged. Register the prepared folder locally."
    : project.connection !== "online"
      ? "Environment is offline. Reconnect the management agent."
      : !project.fresh
        ? "Observation is stale. Wait for a fresh agent observation."
        : diagnostic?.code === "unsupported_protocol"
          ? "Target is incompatible. Update the local CLI and agent."
          : undefined;
  const process = observation.process;
  const startReason =
    unavailable ??
    (diagnostic
      ? `Invalid workflow: ${diagnostic.message}`
      : process.state !== "stopped"
        ? "Start requires a verified stopped process."
        : undefined);
  const stopReason =
    unavailable ??
    (process.state !== "running"
      ? "Stop requires a verified running process."
      : undefined);
  return {
    projectId: project.projectId,
    environmentId: project.environmentId,
    localProjectId: project.localProjectId,
    name: observation.displayName,
    path: observation.canonicalPath,
    connection: project.connection,
    process: process.state,
    historical,
    snapshotHistorical,
    health: typeof snapshot.health === "string" ? snapshot.health : "Unknown",
    activeWork: count(summary.activeRuns),
    retrying: Array.isArray(snapshot.retryQueue)
      ? snapshot.retryQueue.length
      : undefined,
    observedAt: observation.observedAt,
    processObservedAt: process.observedAt,
    snapshotObservedAt: observation.snapshotObservedAt,
    receivedAt: project.lastReceivedAt,
    validation: diagnostic?.message,
    startReason,
    stopReason,
    warnings: project.warnings.map((warning) =>
      warning.state === "identical"
        ? "Identical tracker scope across environments. Advisory only; dispatch remains local."
        : "Tracker scope overlap is unverified. Advisory only; inspect local workflow scopes."
    ),
  };
}

export type ProjectPresentation = ReturnType<typeof presentProject>;

/** Includes retained/unmanaged inventory so the summary and stale filter agree. */
export function isHistoricalOrStale(project: ObservedProject): boolean {
  return (
    !project.managed ||
    !project.fresh ||
    project.snapshotStale ||
    project.connection !== "online"
  );
}

/** Caller supplies the complete workspace inventory, never a filtered page. */
export function summarizeProjects(projects: readonly ObservedProject[]) {
  const managed = projects.filter((project) => project.managed);
  const fresh = managed.filter(
    (project) => project.fresh && project.connection === "online"
  );
  const work = fresh
    .map(presentProject)
    .filter((project) => !project.snapshotHistorical);
  return {
    scope: "Workspace-wide · fresh observations only",
    running: fresh.filter(
      (project) => project.observation.process.state === "running"
    ).length,
    activeWork: work
      .filter((project) => project.process === "running")
      .reduce((sum, project) => sum + (project.activeWork ?? 0), 0),
    unknownWork:
      managed.length - work.filter((p) => p.activeWork !== undefined).length,
    historical: projects.filter(isHistoricalOrStale).length,
  };
}
