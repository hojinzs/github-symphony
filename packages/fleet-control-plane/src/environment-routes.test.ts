import { afterEach, beforeEach, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { openFleetStore, type FleetStore } from "./store.js";
import {
  createEnrollmentService,
  type EnrollmentService,
} from "./enrollment.js";
import { createSessionService, type SessionService } from "./sessions.js";
import {
  createBrowserSecurity,
  type BrowserSession,
} from "./browser-security.js";
import { createProjectRoutes } from "./project-routes.js";
import { createObservationService } from "./observations.js";
import { createEnvironmentRoutes } from "./environment-routes.js";

let dir: string;
let store: FleetStore;
let enrollment: EnrollmentService;
let sessions: SessionService;
let route: ReturnType<typeof createEnvironmentRoutes>;
let browserSession: BrowserSession;
let now: Date;
let failCounts: boolean;
const origin = "https://symphony.lan";
const get = (pathname: string) => route({ method: "GET", pathname });
function post(pathname: string, body: unknown) {
  return route({
    method: "POST",
    pathname,
    body,
    origin,
    cookie: browserSession.setCookie.split(";")[0],
    csrfToken: browserSession.csrfToken,
  });
}
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "c15-routes-")));
  store = openFleetStore(dir);
  failCounts = false;
  now = new Date("2026-10-17T12:00:00Z");
  enrollment = createEnrollmentService(store, {
    now: () => now,
    invalidateManagementAccess: (db, id) => {
      sessions.invalidate(db, id);
      return undefined;
    },
  });
  sessions = createSessionService(store, enrollment, {
    now: () => now,
    receiveObservation: () => undefined,
  });
  const browser = createBrowserSecurity({ publicOrigin: origin });
  browserSession = browser.issueSession();
  route = createEnvironmentRoutes(enrollment, browser, {
    publicOrigin: origin,
    now: () => now,
    projectCounts: async () => {
      if (failCounts) throw new Error("inventory unavailable");
      return new Map();
    },
  });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

it("creates a persisted name-only record and reopens without its old secret (CP-20)", async () => {
  const created = await post("/environments", { name: "host <script>" });
  expect(created?.status).toBe(201);
  const data = JSON.parse(created!.body);
  const token = /id="enrollment-token"[^>]*>([^<]+)</.exec(data.connection)![1];
  expect(data.connection).toContain("Copy setup command");
  expect(data.connection).toContain("Copy token");
  expect(data.connection).toContain("hidden terminal prompt");
  expect(data.connection).toContain("--server &#39;https://symphony.lan&#39;");
  expect(data.rows).toContain("host &lt;script&gt;");
  expect(data.rows).not.toContain(token);
  const reopened = await get(`/environments/${data.environmentId}/connection`);
  expect(reopened?.body).not.toContain(token);
  expect(reopened?.body).toContain("Generate new token");
  expect((await enrollment.listEnvironments())[0].name).toBe("host <script>");
  expect(created?.headers["Cache-Control"]).toBe("no-store");
});

it("regenerates an expired unused token and fences the previous one", async () => {
  const first = await enrollment.createEnvironment({ name: "host" });
  now = new Date(now.getTime() + 600_000);
  const replacement = await post(
    `/environments/${first.environmentId}/regenerate`,
    {}
  );
  expect(replacement?.status).toBe(200);
  expect(replacement?.body).toContain("Copy token");
  await expect(
    enrollment.enroll({
      protocolVersion: 1,
      requestId: randomUUID(),
      token: first.token,
    })
  ).rejects.toThrow();
});

it("advances only on the current session first signal with empty inventory (CP-21)", async () => {
  const token = await enrollment.createEnvironment({ name: "zero" });
  const identity = await enrollment.enroll({
    protocolVersion: 1,
    requestId: randomUUID(),
    token: token.token,
  });
  const path = `/environments/${token.environmentId}/connection`;
  expect((await get(path))?.body).toContain("awaiting-signal");
  expect(
    (await post(`/environments/${token.environmentId}/regenerate`, {}))?.status
  ).toBe(409);
  const opened = await sessions.openSession(identity, {
    protocolVersion: 1,
    requestId: randomUUID(),
    environmentId: identity.environmentId,
    agentId: identity.agentId,
    agentVersion: "fixture",
    host: { hostname: "host", os: "linux" },
  });
  now = new Date(now.getTime() + 30_000);
  sessions.expire();
  const current = await sessions.openSession(identity, {
    protocolVersion: 1,
    requestId: randomUUID(),
    environmentId: identity.environmentId,
    agentId: identity.agentId,
    agentVersion: "fixture",
    host: { hostname: "host", os: "linux" },
  });
  const signal = {
    protocolVersion: 1 as const,
    requestId: randomUUID(),
    environmentId: identity.environmentId,
    sessionId: opened.sessionId,
    sequence: 0,
    observedAt: now.toISOString(),
    inventory: {
      revisionId: randomUUID(),
      pageIndex: 0,
      pageCount: 1,
      projects: [],
    },
  };
  await expect(sessions.observe(identity, signal)).rejects.toThrow();
  expect((await get(path))?.body).toContain("awaiting-signal");
  await sessions.observe(identity, {
    ...signal,
    requestId: randomUUID(),
    sessionId: current.sessionId,
  });
  const online = JSON.parse((await get(path))!.body);
  expect(online.stage).toBe("online");
  expect(online.connection).toContain("Connection successful");
  expect(online.connection).not.toContain("Generate new token");
  expect(online.connection).not.toContain(token.token);
});

it("requires same-origin CSRF, validates names/actions and confirms revocation", async () => {
  expect(
    (
      await route({
        method: "POST",
        pathname: "/environments",
        body: { name: "bad" },
      })
    )?.status
  ).toBe(401);
  expect((await post("/environments", { name: " " }))?.status).toBe(400);
  expect(
    (await post("/environments", { name: "host", token: "forbidden" }))?.status
  ).toBe(400);
  const token = await enrollment.createEnvironment({ name: "saved" });
  const path = `/environments/${token.environmentId}/revoke`;
  expect((await post(path, {}))?.status).toBe(400);
  expect((await get(path))?.status).toBe(405);
  expect((await post(path, { acknowledged: true }))?.body).toContain(
    "Local execution continues"
  );
  expect((await enrollment.listEnvironments())[0].enrollment).toBe("revoked");
  expect((await get("/environments/not-a-uuid/connection"))?.status).toBe(400);
  expect((await get(`/environments/${randomUUID()}/connection`))?.status).toBe(
    404
  );
});

it("serves a safe empty list, local assets and recoverable service failures", async () => {
  const page = await get("/environments");
  expect(page?.status).toBe(200);
  expect(page?.body).toContain("No environments yet");
  expect(page?.body).toContain('aria-current="page" href="/environments"');
  expect(page?.headers["Set-Cookie"]).toContain("HttpOnly");
  expect(page?.headers["Content-Security-Policy"]).toContain(
    "script-src 'self'"
  );
  expect(
    (await get("/fleet-assets/environments.js"))?.headers["Content-Type"]
  ).toContain("javascript");
  expect((await get("/fleet-assets/environments.css"))?.body).toContain(
    "720px"
  );
  expect(await get("/projects")).toBeUndefined();
  store.close();
  const failure = await get("/environments/state");
  expect(failure?.status).toBe(500);
  expect(failure?.body).toContain("Try again");
  expect(failure?.body).not.toContain(dir);
  store = openFleetStore(dir);
});

it("keeps enrollment reads and mutations available during an inventory outage", async () => {
  failCounts = true;
  const created = await post("/environments", { name: "outage host" });
  expect(created?.status).toBe(201);
  const id = JSON.parse(created!.body).environmentId;
  expect((await post(`/environments/${id}/regenerate`, {}))?.status).toBe(200);
  expect((await get(`/environments/${id}/connection`))?.status).toBe(200);
  expect((await get("/environments/state"))?.status).toBe(200);
  expect((await get("/environments"))?.status).toBe(200);
  const revoked = await post(`/environments/${id}/revoke`, {
    acknowledged: true,
  });
  expect(revoked?.status).toBe(200);
  const data = JSON.parse(revoked!.body);
  expect(data.stage).toBe("revoked");
  expect(data.rows).toContain("<dt>Projects</dt><dd>—</dd>");
  expect((await enrollment.listEnvironments())[0].enrollment).toBe("revoked");
});

it("delegates explicit replacement after revocation to the enrollment transaction", async () => {
  const first = await enrollment.createEnvironment({
    name: "replacement host",
  });
  await enrollment.revoke(first.environmentId);
  const response = await post(
    `/environments/${first.environmentId}/regenerate`,
    {}
  );
  expect(response?.status).toBe(200);
  const data = JSON.parse(response!.body);
  const token = /id="enrollment-token"[^>]*>([^<]+)</.exec(data.connection)![1];
  const identity = await enrollment.enroll({
    protocolVersion: 1,
    requestId: randomUUID(),
    token,
  });
  expect(identity.environmentId).toBe(first.environmentId);
});

it("follows the online connection link through the real filtered project route", async () => {
  const first = await enrollment.createEnvironment({ name: "online host" });
  const identity = await enrollment.enroll({
    protocolVersion: 1,
    requestId: randomUUID(),
    token: first.token,
  });
  const opened = await sessions.openSession(identity, {
    protocolVersion: 1,
    requestId: randomUUID(),
    environmentId: identity.environmentId,
    agentId: identity.agentId,
    agentVersion: "fixture",
    host: { hostname: "host", os: "linux" },
  });
  await sessions.observe(identity, {
    protocolVersion: 1,
    requestId: randomUUID(),
    environmentId: identity.environmentId,
    sessionId: opened.sessionId,
    sequence: 0,
    observedAt: now.toISOString(),
    inventory: {
      revisionId: randomUUID(),
      pageIndex: 0,
      pageCount: 1,
      projects: [],
    },
  });
  const online = JSON.parse(
    (await get(`/environments/${first.environmentId}/connection`))!.body
  );
  const href = /href="([^"]+)">View projects/.exec(online.connection)![1];
  const observations = createObservationService(store, {
    now: () => now,
    invalidateProject: () => undefined,
  });
  const projects = createProjectRoutes(observations, {
    environments: enrollment.listEnvironments,
    now: () => now,
  });
  const destination = await projects({ method: "GET", pathname: href });
  expect(destination?.status).toBe(200);
  expect(destination?.body).toContain(
    `value="${first.environmentId}" selected`
  );
});
