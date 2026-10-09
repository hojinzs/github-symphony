// Black-box C04 acceptance against an independent HTTPS peer importing built services.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { request as httpsRequest } from "node:https";
import { randomUUID } from "node:crypto";
import {
  enrollmentTokenResponseSchema,
  enrollmentResponseSchema,
  environmentRecordSchema,
  sessionResponseSchema,
  acknowledgmentSchema,
} from "../packages/management-protocol/dist/index.js";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-blackbox-")));
const certificate = join(dir, "cert.pem"),
  key = join(dir, "key.pem");
let child,
  origin,
  fixtureTime = Date.now();
let assertions = 0;
function check(condition, label) {
  assertions++;
  console.log(`reached: ${label}`);
  assert.ok(condition, label);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Fixture shutdown timeout")),
        5000
      );
      timer.unref();
    }),
  ]);
}
async function start(port = 0) {
  child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./fleet-enrollment-server.mjs", import.meta.url))],
    {
      env: {
        ...process.env,
        FLEET_FIXTURE_DATA: join(dir, "data"),
        FLEET_FIXTURE_CERT: certificate,
        FLEET_FIXTURE_KEY: key,
        FLEET_FIXTURE_TIME: String(fixtureTime),
        FLEET_FIXTURE_PORT: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  let output = "",
    errors = "";
  child.stderr.on("data", (chunk) => {
    errors += chunk;
  });
  origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Fixture startup timeout")),
      10_000
    );
    const fail = (error) => {
      clearTimeout(timer);
      reject(error);
    };
    child.on("error", fail);
    child.on("exit", () => fail(new Error(`Fixture exited: ${errors}`)));
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const line = output.split("\n")[0];
      if (output.includes("\n")) {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(line).origin);
        } catch (error) {
          reject(error);
        }
      }
    });
  });
}
function call(path, { method = "GET", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      new URL(path, origin),
      {
        method,
        ca: readFileSync(certificate),
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
      },
      (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          try {
            resolve({
              status: response.statusCode,
              headers: response.headers,
              body: JSON.parse(data),
            });
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.on("error", reject);
    request.setTimeout(5000, () =>
      request.destroy(new Error("Request timeout"))
    );
    request.end(body ? JSON.stringify(body) : undefined);
  });
}
async function browser() {
  const response = await call("/session");
  check(response.status === 200, "browser bootstrap");
  check(
    response.headers["set-cookie"][0].includes(
      "Secure; HttpOnly; SameSite=Strict"
    ),
    "secure cookie attributes"
  );
  check(
    response.headers["cache-control"] === "no-store",
    "CSRF bootstrap not cached"
  );
  return {
    Origin: origin,
    Cookie: response.headers["set-cookie"][0].split(";")[0],
    "X-CSRF-Token": response.body.csrfToken,
  };
}
const exchange = (token) => ({
  protocolVersion: 1,
  requestId: randomUUID(),
  token,
});
try {
  // Runtime-only certificate/key; the client trusts this CA and verifies its IP SAN.
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      certificate,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" }
  );
  await start();
  let headers = await browser();
  const badOrigin = await call("/api/v1/environments", {
    method: "POST",
    headers: {
      ...headers,
      Origin: "https://foreign.invalid",
      "X-Forwarded-Host": new URL(origin).host,
      "X-Forwarded-Proto": "https",
    },
    body: { name: "Forbidden" },
  });
  check(badOrigin.status === 401, "CP16 foreign origin rejected");
  check(
    !badOrigin.headers["access-control-allow-origin"],
    "permissive CORS absent"
  );
  const missing = { ...headers };
  delete missing["X-CSRF-Token"];
  check(
    (
      await call("/api/v1/environments", {
        method: "POST",
        headers: missing,
        body: { name: "Forbidden" },
      })
    ).status === 401,
    "CP16 missing CSRF rejected"
  );
  const other = await browser();
  check(
    (
      await call("/api/v1/environments", {
        method: "POST",
        headers: { ...headers, "X-CSRF-Token": other["X-CSRF-Token"] },
        body: { name: "Forbidden" },
      })
    ).status === 401,
    "CP16 cross-session CSRF rejected"
  );
  check(
    (await call("/fixture/audits")).body.length === 0,
    "rejected mutations leave no success audit"
  );
  const created = await call("/api/v1/environments", {
    method: "POST",
    headers,
    body: { name: "Prepared host" },
  });
  check(created.status === 201, "CP20 create pending environment");
  const first = enrollmentTokenResponseSchema.parse(created.body);
  const pending = (await call("/api/v1/environments")).body;
  check(
    pending.length === 1 &&
      environmentRecordSchema.parse(pending[0]).enrollment === "pending",
    "CP20 pending list state"
  );
  check(
    !JSON.stringify(pending).includes(first.token),
    "CP20 list does not recover raw token"
  );
  const port = Number(new URL(origin).port);
  await stop();
  await start(port);
  check(
    JSON.stringify((await call("/api/v1/environments")).body[0]) ===
      JSON.stringify(pending[0]) &&
      pending[0].environmentId === first.environmentId,
    "CP20 process restart preserves pending record"
  );
  check(
    (
      await call("/api/v1/environments", {
        method: "POST",
        headers,
        body: { name: "Forbidden" },
      })
    ).status === 401,
    "previous-process browser session rejected"
  );
  headers = await browser();
  const advanced = await call("/fixture/advance", {
    method: "POST",
    headers,
    body: { milliseconds: 600_000 },
  });
  fixtureTime = advanced.body.time;
  check(
    (
      await call("/api/v1/agents/enroll", {
        method: "POST",
        body: exchange(first.token),
      })
    ).status === 401,
    "CP20 exact token expiry"
  );
  const regenerate = await call(
    `/api/v1/environments/${first.environmentId}/enrollment`,
    { method: "POST", headers }
  );
  const second = enrollmentTokenResponseSchema.parse(regenerate.body);
  check(
    second.environmentId === first.environmentId &&
      second.token !== first.token,
    "CP20 regeneration preserves ID and fences token"
  );
  check(
    (
      await call("/api/v1/agents/enroll", {
        method: "POST",
        body: exchange(first.token),
      })
    ).status === 401,
    "CP11 old token rejected"
  );
  const attempt = exchange(second.token);
  const raced = await Promise.all([
    call("/api/v1/agents/enroll", { method: "POST", body: attempt }),
    call("/api/v1/agents/enroll", { method: "POST", body: attempt }),
  ]);
  check(
    raced.filter((result) => result.status === 200).length === 1 &&
      raced.filter((result) => result.status === 401).length === 1,
    "CP11 one-use exchange across concurrent HTTP calls"
  );
  const identity = enrollmentResponseSchema.parse(
    raced.find((result) => result.status === 200).body
  );
  check(
    (await call("/api/v1/environments")).body[0].connection ===
      "awaiting-signal",
    "CP20 exchange alone awaits signal"
  );
  check(
    (
      await call(`/api/v1/environments/${first.environmentId}/enrollment`, {
        method: "POST",
        headers,
      })
    ).status === 409,
    "explicit revocation required for replacement"
  );
  const agentHeaders = { Authorization: `Bearer ${identity.credential}` };
  const sessionInput = {
    protocolVersion: 1,
    requestId: randomUUID(),
    environmentId: identity.environmentId,
    agentId: identity.agentId,
    agentVersion: "fixture-v1",
    host: {
      hostname: "prepared",
      os: process.platform === "darwin" ? "darwin" : "linux",
    },
  };
  check(
    (
      await call("/api/v1/agents/sessions", {
        method: "POST",
        headers,
        body: sessionInput,
      })
    ).status === 401,
    "browser actor cannot authorize agent session"
  );
  check(
    (
      await call("/api/v1/agents/sessions", {
        method: "POST",
        headers: agentHeaders,
        body: { ...sessionInput, environmentId: randomUUID() },
      })
    ).status === 401,
    "CP11 credential scoped to environment"
  );
  const sessionResponse = await call("/api/v1/agents/sessions", {
    method: "POST",
    headers: agentHeaders,
    body: sessionInput,
  });
  const session = sessionResponseSchema.parse(sessionResponse.body);
  const observation = {
    protocolVersion: 1,
    requestId: randomUUID(),
    environmentId: identity.environmentId,
    sessionId: session.sessionId,
    sequence: 1,
    observedAt: new Date(fixtureTime).toISOString(),
    inventory: {
      revisionId: randomUUID(),
      pageIndex: 0,
      pageCount: 1,
      projects: [],
    },
  };
  const signal = await call("/api/v1/agents/observations", {
    method: "POST",
    headers: agentHeaders,
    body: observation,
  });
  check(
    signal.status === 200 &&
      acknowledgmentSchema.parse(signal.body).environmentId ===
        first.environmentId,
    "current authenticated zero-project signal accepted"
  );
  check(
    (await call("/api/v1/environments")).body[0].connection === "online",
    "first authenticated signal becomes online"
  );
  await call("/fixture/commands", {
    method: "POST",
    headers,
    body: { environmentId: first.environmentId },
  });
  check(
    (
      await call(`/api/v1/environments/${first.environmentId}/revoke`, {
        method: "POST",
        headers,
      })
    ).status === 200,
    "CP11 revoke succeeds"
  );
  check(
    (
      await call("/api/v1/agents/observations", {
        method: "POST",
        headers: agentHeaders,
        body: observation,
      })
    ).status === 401,
    "CP11 revoked credential rejected"
  );
  check(
    (await call("/fixture/commands")).body[0].state === "expired",
    "revocation invokes peer command expiry"
  );
  check(
    (await call("/api/v1/environments")).body[0].connection === "offline",
    "revocation marks management offline"
  );
  const audits = (await call("/fixture/audits")).body;
  check(
    audits.some(
      (row) =>
        row.actor === "local-owner" &&
        row.operation === "environment.create" &&
        row.target === first.environmentId &&
        row.outcome === "success"
    ),
    "CP16 valid local-owner operation audited"
  );
  check(
    audits.some(
      (row) =>
        row.operation === "agent.enroll" && row.request_id === attempt.requestId
    ),
    "exchange request identity audited"
  );
  check(
    (statSync(join(dir, "data")).mode & 0o777) === 0o700 &&
      (statSync(join(dir, "data/fleet.sqlite")).mode & 0o777) === 0o600,
    "user-owned persistence permissions"
  );
  const bytes = readFileSync(join(dir, "data/fleet.sqlite"));
  check(
    !bytes.includes(Buffer.from(first.token)) &&
      !bytes.includes(Buffer.from(identity.credential)),
    "SQLite stores only secret verifiers"
  );
  await stop();
  await start(port);
  check(
    (await call("/api/v1/environments")).body[0].enrollment === "revoked",
    "restart preserves revocation"
  );
  console.log(
    `fleet enrollment HTTPS black-box passed (${assertions} reached assertions; ${process.platform})`
  );
} finally {
  await stop();
  if (child && child.exitCode === null) child.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
}
