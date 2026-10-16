import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { ProjectObservation } from "@gh-symphony/management-protocol";
import { openFleetStore, type FleetStore } from "./store.js";
import { createEnrollmentService } from "./enrollment.js";
import { createSessionService, type SessionService } from "./sessions.js";
import {
  createObservationService,
  type ObservationService,
} from "./observations.js";
import { createProjectRoutes } from "./project-routes.js";
import { renderFleetPage, renderProjectFeedback } from "./project-pages.js";

let store: FleetStore,
  root: string,
  observations: ObservationService,
  sessions: SessionService;
let clock: Date;
let route: ReturnType<typeof createProjectRoutes>;
let project: ProjectObservation;
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "c16-")));
  store = openFleetStore(root);
  clock = new Date();
  observations = createObservationService(store, {
    now: () => clock,
    invalidateProject: () => undefined,
  });
  const enrollment = createEnrollmentService(store, {
    now: () => clock,
    invalidateManagementAccess: (db, id) => {
      sessions.invalidate(db, id);
      return undefined;
    },
  });
  sessions = createSessionService(store, enrollment, {
    now: () => clock,
    receiveObservation: observations.receiveObservation,
  });
  for (const name of ["Linux", "Mac"]) {
    const pending = await enrollment.createEnvironment({ name });
    const credential = await enrollment.enroll({
      protocolVersion: 1,
      requestId: randomUUID(),
      token: pending.token,
    });
    const session = await sessions.openSession(credential, {
      protocolVersion: 1,
      requestId: randomUUID(),
      environmentId: credential.environmentId,
      agentId: credential.agentId,
      agentVersion: "fixture",
      host: { hostname: name, os: name === "Linux" ? "linux" : "darwin" },
    });
    project = {
      projectId: observations.identifyProjects(credential.environmentId, [
        "prepared",
      ])[0],
      localProjectId: "prepared",
      displayName: '<script>alert("x")</script>',
      canonicalPath: "/prepared/long/path",
      cliVersion: "fixture",
      validation: {
        state: "invalid",
        diagnostic: { code: "project_invalid", message: "Bad workflow" },
      },
      process: {
        state: "running",
        observedAt: clock.toISOString(),
        identity: "verified",
        pid: 123,
      },
      observedAt: clock.toISOString(),
      snapshotObservedAt: clock.toISOString(),
      snapshot: {
        health: "degraded",
        summary: { activeRuns: 3 },
        retryQueue: [],
        trackerScope: {
          adapter: "github",
          bindingId: "board",
          repository: "owner/repo",
          activeStates: ["Ready"],
          includeLabels: [],
          excludeLabels: [],
        },
      },
      runs: [],
    };
    await sessions.observe(credential, {
      protocolVersion: 1,
      requestId: randomUUID(),
      environmentId: credential.environmentId,
      sessionId: session.sessionId,
      sequence: 0,
      observedAt: clock.toISOString(),
      inventory: {
        revisionId: randomUUID(),
        pageIndex: 0,
        pageCount: 1,
        projects: [project],
      },
    });
  }
  route = createProjectRoutes(observations, {
    environments: enrollment.listEnvironments,
    now: () => clock,
    links: { stop: (id) => "/commands?project=" + id },
  });
});
afterEach(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

it("renders real inventory with consistent filters, paging and workspace-wide totals", async () => {
  const first = await route({
    method: "GET",
    pathname: "/projects?pageSize=1",
  });
  expect(first?.status).toBe(200);
  expect(first?.body).toContain("1–1 of 2 projects");
  expect(first?.body).toContain("Workspace-wide · fresh observations only");
  expect(first?.body).toContain("6</strong> Active runs");
  expect(first?.body).toContain("page=2");
  expect(first?.body).not.toContain('<script>alert("x")</script>');
  expect(first?.body).toContain("&lt;script&gt;");
  const second = await route({
    method: "GET",
    pathname: "/projects?pageSize=1&page=2",
  });
  expect(second?.body).toContain("2–2 of 2 projects");
  const filtered = await route({
    method: "GET",
    pathname:
      "/projects?environment=" +
      (await observations.getProject(project.projectId)).environmentId,
  });
  expect(filtered?.body).toContain("1–1 of 1 projects");
  expect(filtered?.body).toContain("6</strong> Active runs");
  expect(
    (await route({ method: "GET", pathname: "/projects?q=absent&page=9" }))
      ?.body
  ).toContain("No matching projects");
});
it("keeps invalid workflow Stop available and renders disconnect as historical with adjacent reasons", async () => {
  const path = "/projects/" + project.projectId;
  const online = await route({ method: "GET", pathname: path });
  expect(online?.body).toContain('href="/commands?project=');
  expect(online?.body).toContain("Invalid workflow: Bad workflow");
  expect(online?.body).toContain("Identical tracker scope");
  clock = new Date(clock.getTime() + 120_000);
  const offline = await route({ method: "GET", pathname: path });
  expect(offline?.body).toContain("Last known running");
  expect(offline?.body).toContain("historical");
  expect(offline?.body).toContain("Environment is offline");
  expect(offline?.body).not.toContain('href="/commands?project=');
  expect(offline?.body).toContain(project.observedAt);
});
it("offers honest feedback and rejects invalid route inputs without changing runtime state", async () => {
  expect(
    await route({ method: "POST", pathname: "/projects" })
  ).toBeUndefined();
  expect(
    (await route({ method: "GET", pathname: "/projects?page=-1" }))?.status
  ).toBe(400);
  expect(
    (await route({ method: "GET", pathname: "/projects/not-an-id" }))?.status
  ).toBe(400);
  expect(
    (await route({ method: "GET", pathname: "/projects/" + randomUUID() }))
      ?.status
  ).toBe(404);
  const failed = createProjectRoutes(observations, {
    environments: async () => {
      throw new Error("injected directory fault");
    },
  });
  const error = await failed({
    method: "GET",
    pathname: "/projects?q=prepared",
  });
  expect(error?.status).toBe(503);
  expect(error?.body).toContain("Try again");
  expect(error?.body).not.toContain("injected directory fault");
  expect(error?.headers["Cache-Control"]).toBe("no-store");
  expect(renderProjectFeedback("loading")).toContain('aria-busy="true"');
  expect(renderProjectFeedback("error")).toContain("Try again");
  expect(renderProjectFeedback("empty")).toContain(
    "Register a prepared folder"
  );
  const asset = await route({
    method: "GET",
    pathname: "/fleet-assets/imgOhMySymphonyMark.svg",
  });
  expect(asset?.headers["Content-Type"]).toBe("image/svg+xml");
  expect(asset?.body.length).toBeGreaterThan(0);
  expect(
    await route({ method: "GET", pathname: "/fleet-assets/../../package.json" })
  ).toBeUndefined();
});

it("counts online stale observations in the explicitly combined offline/stale metric", async () => {
  const stale = {
    ...(await observations.getProject(project.projectId)),
    fresh: false,
  };
  const html = renderFleetPage({
    all: [stale],
    items: [stale],
    total: 1,
    page: 1,
    pageSize: 25,
    query: "",
    environment: "",
    state: "",
    environments: [],
    now: clock,
  });
  expect(html).toContain("1</strong> Offline / stale projects");
  expect(html).toContain("Last known running");
});

it("uses the same stale inventory for metric, filter, count and pagination", async () => {
  const current = await observations.getProject(project.projectId);
  const inventory = [
    current,
    { ...current, projectId: randomUUID(), snapshotStale: true },
    { ...current, projectId: randomUUID(), fresh: false },
    { ...current, projectId: randomUUID(), connection: "offline" as const },
    { ...current, projectId: randomUUID(), managed: false },
  ];
  const pages = createProjectRoutes(
    {
      ...observations,
      listProjects: async () => ({ items: inventory }),
    },
    { environments: async () => [], now: () => clock }
  );
  const stale = await pages({
    method: "GET",
    pathname: "/projects?state=stale&pageSize=1&page=4",
  });
  expect(stale?.body).toContain("4</strong> Offline / stale projects");
  expect(stale?.body).toContain("All inventory · includes unmanaged");
  expect(stale?.body).toContain("4–4 of 4 projects");
  expect(stale?.body).toContain("2</strong> Running");
  const running = await pages({
    method: "GET",
    pathname: "/projects?state=running",
  });
  expect(running?.body).toContain("1–2 of 2 projects");
  for (const item of inventory) {
    item.observation = {
      ...item.observation,
      process: { state: "stopped", observedAt: clock.toISOString() },
    };
  }
  const stopped = await pages({
    method: "GET",
    pathname: "/projects?state=stopped",
  });
  expect(stopped?.body).toContain("1–2 of 2 projects");
  expect(stopped?.body).not.toContain("Last known stopped");
});
