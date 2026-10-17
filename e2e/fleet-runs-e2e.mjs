import assert from "node:assert/strict";
import { createRunFixture } from "./fleet-runs-fixture.mjs";

const fixture = await createRunFixture();
let count = 0;
function check(value, label) {
  console.log("reached: " + label);
  count++;
  assert.ok(value, label);
}
try {
  const page = await fixture.http("GET", fixture.path);
  const cookie = page.headers["set-cookie"][0].split(";")[0];
  const csrf = /data-csrf="([^"]+)"/.exec(page.text)[1];
  check(
    page.status === 200 &&
      page.text.includes(fixture.environmentId) &&
      page.text.includes(fixture.projectId),
    "project-scoped history"
  );
  check(
    page.text.includes("1–25 of 26") &&
      (page.text.match(/class="timeline-item"/g) ?? []).length === 25 &&
      (await fixture.http("GET", fixture.path + "?page=2")).text.includes(
        "26–26 of 26"
      ),
    "bounded history paging"
  );
  for (const query of [
    "?run=foreign",
    "?stream=../../secret",
    "?path=/etc/passwd",
  ])
    check(
      (await fixture.http("GET", fixture.path + query)).status === 400,
      "invalid selection " + query
    );
  check(
    (
      await fixture.http(
        "POST",
        "/api/v1/projects/" + fixture.projectId + "/reads",
        { body: { kind: "runs", limit: 25 } }
      )
    ).status === 401,
    "CSRF required"
  );
  const fetcher = async (path, init) => {
    const response = await fixture.http(init?.method ?? "GET", path, {
      cookie,
      csrf,
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    return new Response(response.text, {
      status: response.status,
      headers: response.headers,
    });
  };
  const { RunLogModel } =
    await import("../packages/fleet-control-plane/dist/run-log-model.js");
  const { BoundedLogReader } =
    await import("../packages/fleet-control-plane/dist/log-read-client.js");
  const model = new RunLogModel(
    {
      projectId: fixture.projectId,
      environmentId: fixture.environmentId,
      runId: "run-001",
      stream: "worker",
    },
    ["run-001"]
  );
  const reader = new BoundedLogReader(model, csrf, fetcher);
  await reader.read();
  check(
    model.phase === "ready" &&
      model.text.includes("<script>") &&
      model.fetchedAt,
    "actual filesystem log"
  );
  fixture.append("appended\n");
  await reader.read();
  check(
    model.text.endsWith("appended\n") &&
      fixture.selections[1].cursor &&
      fixture.selections.every((s) => s.maxBytes === 262144),
    "bounded continuation"
  );
  fixture.rotate();
  await reader.read();
  check(
    model.phase === "reset-required" && model.text.includes("session started"),
    "explicit rotation reset"
  );
  model.reset();
  await reader.read();
  check(model.text === "new generation\n", "fresh generation");
  fixture.truncate();
  await reader.read();
  check(model.phase === "reset-required", "explicit truncation reset");
  model.reset();
  fixture.large();
  await reader.read();
  check(
    new TextEncoder().encode(model.text).length === 262144 &&
      !model.text.includes("\ufffd"),
    "UTF-8 byte bound"
  );
  const missing = new RunLogModel({ ...model.identity, runId: "run-002" }, [
    "run-002",
  ]);
  await new BoundedLogReader(missing, csrf, fetcher).read();
  check(
    missing.phase === "unavailable" && missing.text === "",
    "missing file unavailable"
  );
  const before = model.text;
  const fetchedAt = model.fetchedAt;
  model.follow();
  await fixture.offline(true);
  await reader.read();
  check(
    model.phase === "offline" &&
      model.text === before &&
      model.fetchedAt === fetchedAt &&
      model.historical &&
      !model.following,
    "offline preserves history"
  );
  const state = JSON.parse(
    (await fixture.http("GET", fixture.path + "/state")).text
  );
  check(
    state.online === false && state.environmentId === fixture.environmentId,
    "offline connection projection"
  );
  await fixture.offline(false);
  model.reconnect();
  check(!model.following && model.historical, "reconnect stays paused");
  const bundle = await fixture.http("GET", "/fleet-assets/runs.js");
  check(
    bundle.status === 200 &&
      bundle.text.includes("mountRunLogPage") &&
      !bundle.text.includes('from "@gh-symphony'),
    "local browser bundle"
  );
  console.log(
    "C18 HTTPS/filesystem blackbox passed (" +
      count +
      " reached assertions; actual " +
      process.platform +
      ")"
  );
} finally {
  await fixture.close();
}
