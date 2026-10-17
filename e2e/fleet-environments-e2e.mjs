import assert from "node:assert/strict";
import { platform } from "node:os";
import { createHarness } from "./fleet-environments-harness.mjs";
const f = await createHarness();
let reached = 0;
function check(value, label) {
  console.log("reached: " + label);
  reached++;
  if (!process.env.C15_ASSERTION || process.env.C15_ASSERTION === label)
    assert.ok(value, label);
}
try {
  const page = await f.request("/environments");
  const cookie = page.headers["set-cookie"][0].split(";")[0];
  const csrfToken = /data-csrf="([^"]+)"/.exec(page.body)[1];
  const post = (path, body) =>
    f.request(path, { method: "POST", cookie, csrfToken, body });
  check(
    page.status === 200 && page.body.includes("No environments yet"),
    "empty list"
  );
  const denied = await f.request("/environments", {
    method: "POST",
    body: { name: "denied" },
  });
  check(
    denied.status === 401 && (await f.environments()).length === 0,
    "CSRF blocks creation"
  );
  const created = await post("/environments", { name: "prepared <host>" });
  const data = JSON.parse(created.body),
    id = data.environmentId,
    path = `/environments/${id}/connection`;
  const token = /id="enrollment-token"[^>]*>([^<]+)</.exec(data.connection)[1];
  check(
    created.status === 201 &&
      data.rows.includes("&lt;host&gt;") &&
      !data.rows.includes(token),
    "escaped persisted record"
  );
  const command = /id="setup-command">([^<]+)</.exec(data.connection)[1];
  check(
    !command.includes(token) &&
      command.includes("--server") &&
      data.connection.includes("Copy token"),
    "separate command and token"
  );
  f.restart();
  const reopened = await f.request(path);
  check(
    reopened.status === 200 &&
      !reopened.body.includes(token) &&
      reopened.body.includes("Generate new token"),
    "CP20 restart reopen secret absent"
  );
  f.advance(1);
  const regenerated = JSON.parse(
    (await post(`/environments/${id}/regenerate`, {})).body
  );
  const replacement = /id="enrollment-token"[^>]*>([^<]+)</.exec(
    regenerated.connection
  )[1];
  let rejected = false;
  try {
    await f.enroll(token);
  } catch {
    rejected = true;
  }
  check(rejected && replacement !== token, "old token fenced");
  const identity = await f.enroll(replacement);
  const waiting = JSON.parse((await f.request(path)).body);
  check(
    waiting.stage === "awaiting-signal" &&
      waiting.connection.includes("Copy resume command") &&
      !waiting.connection.includes(replacement),
    "exchange awaits first signal"
  );
  check(
    (await post(`/environments/${id}/regenerate`, {})).status === 409,
    "enrolled cannot regenerate"
  );
  await f.signal(identity);
  const online = JSON.parse((await f.request(path)).body);
  check(
    online.stage === "online" &&
      online.connection.includes("No projects yet") &&
      online.connection.includes("0 projects"),
    "CP21 zero project success"
  );
  const revoked = await post(`/environments/${id}/revoke`, {
    acknowledged: true,
  });
  check(
    revoked.status === 200 &&
      JSON.parse(revoked.body).stage === "revoked" &&
      revoked.body.includes("Local execution continues"),
    "revoked access semantics"
  );
  f.failReads(true);
  check(
    (await f.request("/environments/state")).status === 500,
    "read error recovery"
  );
  f.failReads(false);
  check(
    (await f.request("/environments/state")).status === 200,
    "read recovery succeeds"
  );
  console.log(
    JSON.stringify({
      suite: "C15 HTTPS",
      os: platform(),
      reached,
      result: "pass",
    })
  );
} finally {
  await f.close();
}
