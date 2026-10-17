import assert from "node:assert/strict";
import { platform } from "node:os";
import { createHarness } from "./fleet-command-ui-harness.mjs";
function check(value, label) {
  console.log("reached: " + label);
  assert.ok(value, label);
}
const field = (html, name) =>
  new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1];
const cookie = (response) => response.headers["set-cookie"][0].split(";")[0];
const f = await createHarness();
try {
  const path = `/projects/${f.ids.interactive}/commands`;
  const confirmation = await f.request(path + "/stop");
  check(
    confirmation.status === 200 &&
      confirmation.body.includes("2 observed active runs") &&
      confirmation.body.includes("Stopping interrupts active runs"),
    "stop impact"
  );
  check(
    (await f.commands.listCommands(f.ids.interactive, { limit: 25 })).items
      .length === 0,
    "inert GET"
  );
  const input = {
    csrf: field(confirmation.body, "csrf"),
    operation: "stop",
    idempotencyKey: field(confirmation.body, "idempotencyKey"),
  };
  check(
    (
      await f.request(path, {
        method: "POST",
        body: input,
        cookie: cookie(confirmation),
        origin: "https://evil.invalid",
      })
    ).status === 401,
    "CSRF fence"
  );
  const submitted = await f.request(path, {
    method: "POST",
    body: input,
    cookie: cookie(confirmation),
  });
  check(submitted.status === 303, "accepted redirect");
  let page = await f.request(submitted.headers.location);
  check(
    page.body.includes("stop · accepted") &&
      page.body.includes("running · online"),
    "independent pending observation"
  );
  f.setDisabled("Observation is stale. Wait for fresh verification.");
  page = await f.request(path + "/stop");
  check(
    page.body.includes('disabled aria-describedby="eligibility-reason"') &&
      page.body.includes("Observation is stale"),
    "stale eligibility"
  );
  f.setDisabled(undefined);
  for (const state of [
    "accepted",
    "executing",
    "succeeded",
    "failed",
    "expired",
    "unknown",
  ]) {
    page = await f.request(`/commands/${f.records[state]}`);
    check(
      page.status === 200 &&
        page.body.includes(`stop · ${state}`) &&
        page.body.includes("Independent process observation"),
      "outcome " + state
    );
  }
  page = await f.request(`/commands/${f.records.superseded}`);
  check(
    page.body.includes("replacement process was not stopped by this command") &&
      page.body.includes("running · online"),
    "superseded safety"
  );
  const unknown = `/commands/${f.records.unknown}`;
  page = await f.request(unknown);
  check(
    !page.body.match(/>Retry<|>Stop project<|>Start project</) &&
      page.body.includes('name="reason" required'),
    "unknown no replay"
  );
  const csrf = field(page.body, "csrf"),
    session = cookie(page);
  check(
    (
      await f.request(unknown + "/close-unresolved", {
        method: "POST",
        cookie: session,
        body: { csrf, reason: "Inspected host", acknowledge: "true" },
      })
    ).status === 400,
    "second confirmation fence"
  );
  check(
    (
      await f.request(unknown + "/closure-confirmation", {
        method: "POST",
        cookie: session,
        body: { csrf, reason: " " },
      })
    ).status === 400,
    "required reason"
  );
  const review = await f.request(unknown + "/closure-confirmation", {
    method: "POST",
    cookie: session,
    body: { csrf, reason: "Inspected host" },
  });
  check(
    review.status === 200 &&
      review.body.includes("Confirm close unresolved") &&
      !(await f.commands.getCommand(f.records.unknown)).closure,
    "review is inert"
  );
  const closed = await f.request(unknown + "/close-unresolved", {
    method: "POST",
    cookie: session,
    body: {
      csrf,
      reason: "Inspected host",
      acknowledge: "true",
      review: field(review.body, "review"),
    },
  });
  const durable = await f.commands.getCommand(f.records.unknown);
  check(
    closed.status === 303 &&
      durable.state === "unknown" &&
      durable.closure?.reason === "Inspected host",
    "durable unknown closure"
  );
  page = await f.request(`/projects/${f.ids.unknown}/commands`);
  check(page.body.includes("unknown · closed unresolved"), "retained history");
  page = await f.request(`/projects/${f.ids.invalid}/commands/stop`);
  const validStop = await f.request(`/projects/${f.ids.invalid}/commands`, {
    method: "POST",
    cookie: cookie(page),
    body: {
      csrf: field(page.body, "csrf"),
      operation: "stop",
      idempotencyKey: field(page.body, "idempotencyKey"),
    },
  });
  check(validStop.status === 303, "invalid workflow stop");
  f.setUnavailable(true);
  page = await f.request(submitted.headers.location);
  check(
    page.status === 503 &&
      page.body.includes(
        "Inspect command history before submitting any new intent"
      ),
    "ambiguous response guidance"
  );
  console.log(
    `C17 HTTPS blackbox passed on ${platform()} (21 reached assertions; protocol/process observations are fixtures, no native lifecycle claim)`
  );
} finally {
  await f.close();
}
