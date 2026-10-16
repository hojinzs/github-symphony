// C16 read-only private-listener fixture; actual C04/C05/C06 services.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  openFleetStore,
  createEnrollmentService,
  createSessionService,
  createObservationService,
  createProjectRoutes,
} from "../packages/fleet-control-plane/dist/index.js";
const data = mkdtempSync(join(tmpdir(), "c16-blackbox-"));
const store = openFleetStore(realpathSync(data));
let clock = new Date();
const observations = createObservationService(store, {
  now: () => clock,
  invalidateProject: () => undefined,
});
let sessions;
const enrollment = createEnrollmentService(store, {
  now: () => clock,
  invalidateManagementAccess: (db, id) => sessions.invalidate(db, id),
});
sessions = createSessionService(store, enrollment, {
  now: () => clock,
  receiveObservation: observations.receiveObservation,
});
let detail;
for (const name of ["lab-linux", "studio-mac", "build-host"]) {
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
    host: { hostname: name, os: name === "studio-mac" ? "darwin" : "linux" },
  });
  const projects = observations
    .identifyProjects(credential.environmentId, ["first", "second"])
    .map((id, i) => ({
      projectId: id,
      localProjectId: i ? "second" : "first",
      displayName: i ? "github-symphony" : "<script>api-platform</script>",
      canonicalPath: "/home/operator/projects/api-platform",
      cliVersion: "fixture",
      validation: { state: "valid" },
      process: i
        ? { state: "stopped", observedAt: clock.toISOString() }
        : {
            state: "running",
            observedAt: clock.toISOString(),
            identity: "verified",
            pid: 123,
          },
      observedAt: clock.toISOString(),
      snapshotObservedAt: clock.toISOString(),
      snapshot: {
        health: "healthy",
        summary: { activeRuns: i ? 0 : 2 },
        retryQueue: [],
      },
      runs: [],
    }));
  detail = projects[0].projectId;
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
      projects,
    },
  });
}

const routes = createProjectRoutes(observations, {
  environments: enrollment.listEnvironments,
  now: () => clock,
  links: { stop: (id) => "/commands?project=" + id },
});
const server = createServer(async (req, res) => {
  const result = await routes({ method: req.method, pathname: req.url });
  if (!result) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.writeHead(result.status, result.headers);
  res.end(result.body);
});
function check(value, label) {
  console.log("reached: " + label);
  assert.ok(value, label);
}
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = "http://127.0.0.1:" + server.address().port;
  const get = async (path) => {
    const response = await fetch(origin + path);
    return { status: response.status, body: await response.text() };
  };
  let result = await get("/projects?pageSize=1");
  check(
    result.body.includes("1–1 of 6 projects") && result.body.includes("page=2"),
    "paging"
  );
  check(result.body.includes("6</strong> Active runs"), "fresh totals");
  result = await get("/projects");
  check(
    !result.body.includes("<script>api-platform</script>") &&
      result.body.includes("&lt;script&gt;"),
    "escaped inventory"
  );
  check(
    result.body.includes("Tracker scope overlap is unverified"),
    "scope advisory"
  );
  result = await get("/projects?q=missing");
  check(
    result.body.includes("No matching projects") &&
      result.body.includes("6</strong> Active runs"),
    "filtered summary scope"
  );
  result = await get("/projects/" + detail);
  check(result.body.includes('href="/commands?project='), "verified Stop");
  const observed = (await observations.getProject(detail)).observation
    .observedAt;
  clock = new Date(clock.getTime() + 120000);
  result = await get("/projects/" + detail);
  check(
    result.body.includes("Last known running") &&
      result.body.includes(observed),
    "historical process"
  );
  check(
    !result.body.includes('href="/commands?project=') &&
      result.body.includes("Environment is offline"),
    "offline actions"
  );
  result = await get("/projects");
  check(result.body.includes("0</strong> Active runs"), "offline totals");
  result = await get("/fleet-assets/imgOhMySymphonyMark.svg");
  check(
    result.status === 200 && result.body.includes("<svg"),
    "local design asset"
  );
  result = await get("/projects?page=-1");
  check(result.status === 400, "invalid query");
  console.log(
    "C16 fleet projects blackbox passed (11 reached assertions; HTTP fixture, no native lifecycle claims)"
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  store.close();
  rmSync(data, { recursive: true, force: true });
}
