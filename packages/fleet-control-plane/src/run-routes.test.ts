import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { openFleetStore } from "./store.js";
import { createEnrollmentService } from "./enrollment.js";
import { createSessionService } from "./sessions.js";
import { createObservationService } from "./observations.js";
import { createBrowserSecurity } from "./browser-security.js";
import { createRunRoutes } from "./run-routes.js";
import { createProjectRoutes } from "./project-routes.js";

it("renders retained C06 runs with safe known selection, paging and offline identity", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "c18-routes-")));
  const store = openFleetStore(root);
  const now = new Date();
  try {
    const observations = createObservationService(store, {
      now: () => now,
      invalidateProject: () => undefined,
    });
    const enrollment = createEnrollmentService(store, {
      now: () => now,
      invalidateManagementAccess: () => undefined,
    });
    const pending = await enrollment.createEnvironment({ name: "Lab Linux" });
    const credential = await enrollment.enroll({
      protocolVersion: 1,
      requestId: randomUUID(),
      token: pending.token,
    });
    const sessions = createSessionService(store, enrollment, {
      now: () => now,
      receiveObservation: observations.receiveObservation,
    });
    const session = await sessions.openSession(credential, {
      protocolVersion: 1,
      requestId: randomUUID(),
      environmentId: credential.environmentId,
      agentId: credential.agentId,
      agentVersion: "fixture",
      host: { hostname: "host", os: "linux" },
    });
    const projectId = observations.identifyProjects(credential.environmentId, [
      "prepared",
    ])[0];
    await sessions.observe(credential, {
      protocolVersion: 1,
      requestId: randomUUID(),
      environmentId: credential.environmentId,
      sessionId: session.sessionId,
      sequence: 0,
      observedAt: now.toISOString(),
      inventory: {
        revisionId: randomUUID(),
        pageIndex: 0,
        pageCount: 1,
        projects: [
          {
            projectId,
            localProjectId: "prepared",
            displayName: "<script>unsafe</script>",
            canonicalPath: "/prepared",
            cliVersion: "fixture",
            validation: { state: "valid" },
            process: { state: "stopped", observedAt: now.toISOString() },
            observedAt: now.toISOString(),
            runs: Array.from({ length: 26 }, (_, i) => ({
              runId: i === 0 ? "<run>" : "run-" + i,
              status: "completed",
              startedAt: now.toISOString(),
              updatedAt: now.toISOString(),
            })),
          },
        ],
      },
    });
    const browser = createBrowserSecurity({
      publicOrigin: "https://fleet.example",
    });
    const route = createRunRoutes(observations, browser, {
      environments: enrollment.listEnvironments,
    });
    const path = "/projects/" + projectId + "/runs";
    const page = await route({ method: "GET", pathname: path });
    expect(page?.status).toBe(200);
    expect(page?.body).toContain("Recent runs");
    expect(page?.body).toContain("1–25 of 26");
    expect(page?.body).toContain("&lt;run&gt;");
    expect(page?.body).not.toContain("<script>unsafe</script>");
    expect(page?.body).toContain(credential.environmentId);
    expect(page?.headers["Set-Cookie"]).toContain("HttpOnly");
    const secondTab = await route({ method: "GET", pathname: path });
    expect(secondTab?.headers["Set-Cookie"]).toBe(page?.headers["Set-Cookie"]);
    expect(page?.headers["Content-Security-Policy"]).toContain(
      "connect-src 'self'"
    );
    expect(
      (await route({ method: "GET", pathname: path + "?page=2" }))?.body
    ).toContain("26–26 of 26");
    for (const query of [
      "?run=foreign",
      "?stream=../../secret",
      "?path=/etc/passwd",
      "?page=0",
      "?run=a&run=b",
    ]) {
      expect(
        (await route({ method: "GET", pathname: path + query }))?.status
      ).toBe(400);
    }
    const projects = createProjectRoutes(observations, {
      environments: enrollment.listEnvironments,
    });
    expect(
      (await projects({ method: "GET", pathname: "/projects/" + projectId }))
        ?.body
    ).toContain(path);
    now.setTime(now.getTime() + 120_000);
    const offline = await route({ method: "GET", pathname: path });
    expect(offline?.body).toContain("Historical");
    expect(offline?.body).toContain("Follow paused");
    const state = await route({ method: "GET", pathname: path + "/state" });
    expect(JSON.parse(state!.body)).toMatchObject({
      environmentId: credential.environmentId,
      projectId,
      online: false,
      lastObservedAt: expect.any(String),
    });
    expect(await route({ method: "POST", pathname: path })).toBeUndefined();
    expect(
      (await route({ method: "GET", pathname: "/projects/invalid/runs" }))
        ?.status
    ).toBe(400);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
