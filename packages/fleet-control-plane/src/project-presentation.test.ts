import { expect, it } from "vitest";
import type { ObservedProject } from "./observations.js";
import { presentProject, summarizeProjects } from "./project-presentation.js";

function fixture(overrides: Partial<ObservedProject> = {}): ObservedProject {
  return {
    projectId: "a",
    environmentId: "linux",
    localProjectId: "prepared",
    managed: true,
    connection: "online",
    fresh: true,
    snapshotStale: false,
    lastReceivedAt: "2026-10-16T09:00:01Z",
    observation: {
      projectId: "a",
      localProjectId: "prepared",
      displayName: "Prepared",
      canonicalPath: "/prepared",
      cliVersion: "1.0.0",
      validation: { state: "valid" },
      process: {
        state: "running",
        observedAt: "2026-10-16T09:00:00Z",
        identity: "verified",
        pid: 12,
      },
      observedAt: "2026-10-16T09:00:00Z",
      snapshotObservedAt: "2026-10-16T09:00:00Z",
      snapshot: {
        health: "degraded",
        summary: { activeRuns: 3 },
        retryQueue: [{}],
      },
      runs: [],
    },
    warnings: [],
    ...overrides,
  };
}
it("excludes offline, stale and missing snapshots from fresh workspace work totals", () => {
  const fresh = fixture();
  const offline = fixture({ connection: "offline", fresh: false });
  const stale = fixture({ fresh: false });
  const missing = fixture({ snapshotStale: true });
  expect(summarizeProjects([fresh, offline, stale, missing])).toEqual({
    scope: "Workspace-wide · fresh observations only",
    registered: 4,
    running: 2,
    activeWork: 3,
    unknownWork: 3,
    historical: 2,
  });
  const view = presentProject(offline);
  expect(view).toMatchObject({
    process: "running",
    health: "degraded",
    activeWork: 3,
    historical: true,
    observedAt: fresh.observation.observedAt,
    receivedAt: offline.lastReceivedAt,
  });
  expect(view.stopReason).toContain("offline");
});
it("preserves verified Stop for invalid workflows while fencing unsafe targets", () => {
  const project = fixture();
  project.observation.validation = {
    state: "invalid",
    diagnostic: { code: "project_invalid", message: "Bad workflow" },
  };
  expect(presentProject(project)).toMatchObject({
    startReason: "Invalid workflow: Bad workflow",
    stopReason: undefined,
  });
  expect(presentProject({ ...project, managed: false }).stopReason).toContain(
    "unmanaged"
  );
  expect(presentProject({ ...project, fresh: false }).stopReason).toContain(
    "stale"
  );
  project.observation.validation.diagnostic.code = "unsupported_protocol";
  expect(presentProject(project).stopReason).toContain("incompatible");
  project.observation.validation = { state: "valid" };
  project.observation.process = {
    state: "unknown",
    observedAt: project.observation.observedAt,
    diagnostic: { code: "process_unverified", message: "Unavailable" },
  };
  expect(presentProject(project).stopReason).toContain("verified running");
});
it("keeps environment-qualified identity, unknown counts and advisory scope warnings", () => {
  const project = fixture({
    environmentId: "macos",
    warnings: [{ state: "identical", projectIds: ["a", "b"] }],
  });
  project.observation.snapshot = { summary: { activeRuns: -1 } };
  expect(presentProject(project)).toMatchObject({
    environmentId: "macos",
    localProjectId: "prepared",
    health: "Unknown",
    activeWork: undefined,
    retrying: undefined,
  });
  expect(presentProject(project).warnings[0]).toContain("Advisory only");
  expect(summarizeProjects([project]).unknownWork).toBe(1);
});
