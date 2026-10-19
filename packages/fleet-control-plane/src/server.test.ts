import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFleetServer, type FleetServer } from "./server.js";

const roots: string[] = [];
const listeners: FleetServer[] = [];
afterEach(async () => {
  await Promise.all(listeners.splice(0).map((server) => server.close()));
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fleet-server-")));
  roots.push(root);
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(root, "key.pem"),
      "-out",
      join(root, "cert.pem"),
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
      "-days",
      "1",
    ],
    { stdio: "ignore" }
  );
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve)
  );
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const origin = `https://127.0.0.1:${port}`;
  const input = {
    publicOrigin: origin,
    dataDir: join(root, "data"),
    port,
    transport: { mode: "tls", certFile: "cert.pem", keyFile: "key.pem" },
  };
  const file = join(root, "fleet.yaml");
  const save = (value: unknown) => writeFileSync(file, JSON.stringify(value));
  save(input);
  const start = async () => {
    const server = await startFleetServer(file);
    listeners.push(server);
    return server;
  };
  const request = (
    path: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
      raw?: string;
    } = {}
  ) =>
    new Promise<{
      status: number;
      body: string;
      headers: import("node:http").IncomingHttpHeaders;
    }>((resolve, reject) => {
      const raw =
        options.raw ??
        (options.body === undefined ? undefined : JSON.stringify(options.body));
      const req = httpsRequest(
        origin + path,
        {
          method: options.method ?? "GET",
          ca: readFileSync(join(root, "cert.pem")),
          servername: "localhost",
          headers: {
            ...(raw === undefined
              ? {}
              : { "Content-Type": "application/json" }),
            ...options.headers,
          },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () =>
            resolve({ status: res.statusCode!, body, headers: res.headers })
          );
        }
      );
      req.on("error", reject);
      req.end(raw);
    });
  const browser = async () => {
    const page = await request("/environments");
    const cookie = page.headers["set-cookie"]![0].split(";")[0];
    const csrf = /data-csrf="([^"]+)"/.exec(page.body)![1];
    return { cookie, Origin: origin, "X-CSRF-Token": csrf };
  };
  return { root, input, file, save, start, request, browser };
}

// Breaking observation projection or startup recovery must fail this actual wire test.
it("serves private HTTPS pages, enrolls and records a zero-project first signal across restart", async () => {
  const f = await fixture();
  const server = await f.start();
  expect((await f.request("/healthz")).body).toBe('{"status":"ready"}');
  expect((await f.request("/")).headers.location).toBe("/environments");
  const browser = await f.browser();
  expect((await f.request("/projects")).status).toBe(200);
  for (const path of [
    "/fleet-assets/projects.css",
    "/fleet-assets/imgSymbolLayers.svg",
    "/fleet-assets/environments/imgSymbolLayers.svg",
    "/fleet-assets/runs/imgSymbolLayers.svg",
  ])
    expect((await f.request(path)).status, path).toBe(200);
  const created = await f.request("/environments", {
    method: "POST",
    headers: browser,
    body: { name: "Test host" },
  });
  expect(created.status).toBe(201);
  const id = JSON.parse(created.body).environmentId;
  const panel = JSON.parse(created.body).connection as string;
  const enrollmentToken = /id="enrollment-token"[^>]*>([^<]+)<\/textarea>/.exec(
    panel
  )?.[1];
  expect(enrollmentToken, panel).toBeTruthy();
  const enrolled = await f.request("/api/v1/agents/enroll", {
    method: "POST",
    body: {
      protocolVersion: 1,
      requestId: randomUUID(),
      token: enrollmentToken,
    },
  });
  expect(enrolled.status).toBe(200);
  const identity = JSON.parse(enrolled.body);
  const auth = { Authorization: `Bearer ${identity.credential}` };
  const sessionRequest = {
    protocolVersion: 1,
    requestId: randomUUID(),
    environmentId: id,
    agentId: identity.agentId,
    agentVersion: "test",
    host: { hostname: "test", os: "linux" },
  };
  const session = await f.request("/api/v1/agents/sessions", {
    method: "POST",
    headers: auth,
    body: sessionRequest,
  });
  expect(session.status).toBe(200);
  const sessionId = JSON.parse(session.body).sessionId;
  const signal = {
    protocolVersion: 1,
    requestId: randomUUID(),
    environmentId: id,
    sessionId,
    sequence: 0,
    observedAt: new Date().toISOString(),
    inventory: {
      revisionId: randomUUID(),
      pageIndex: 0,
      pageCount: 2,
      projects: [],
    },
  };
  expect(
    (
      await f.request("/api/v1/agents/observations", {
        method: "POST",
        headers: auth,
        body: signal,
      })
    ).status
  ).toBe(200);
  const partial = await f.request(`/environments/${id}/connection`);
  expect(JSON.parse(partial.body).connection).toContain(
    "Project inventory has not been reported"
  );
  signal.sequence = 1;
  signal.inventory.pageIndex = 1;
  expect(
    (
      await f.request("/api/v1/agents/observations", {
        method: "POST",
        headers: auth,
        body: signal,
      })
    ).status
  ).toBe(200);
  await expect(startFleetServer(f.file)).rejects.toThrow(/Fleet bind/);
  expect(
    (
      await f.request("/api/v1/agents/observations", {
        method: "POST",
        headers: auth,
        body: signal,
      })
    ).status
  ).toBe(200);
  const online = await f.request(`/environments/${id}/connection`);
  expect(JSON.parse(online.body).stage).toBe("online");
  expect(JSON.parse(online.body).connection).toContain("No projects yet");
  await server.close();
  await expect(f.request("/healthz")).rejects.toThrow();
  await f.start();
  expect((await f.request("/environments")).body).toContain("Test host");
  expect(
    (
      await f.request("/api/v1/agents/observations", {
        method: "POST",
        headers: auth,
        body: signal,
      })
    ).status
  ).toBe(401);
  expect(
    (
      await f.request("/api/v1/agents/sessions", {
        method: "POST",
        headers: auth,
        body: { ...sessionRequest, requestId: randomUUID() },
      })
    ).status
  ).toBe(200);
});

it("rejects cross-origin, missing CSRF, duplicate bodies and browser identity on agent routes", async () => {
  const f = await fixture();
  await f.start();
  const browser = await f.browser();
  for (const headers of [
    {},
    { ...browser, Origin: "https://other.invalid" },
    { ...browser, "X-CSRF-Token": "wrong" },
  ])
    expect(
      (
        await f.request("/environments", {
          method: "POST",
          headers,
          body: { name: "Forbidden" },
        })
      ).status
    ).toBe(401);
  expect(
    (
      await f.request("/environments", {
        method: "POST",
        headers: browser,
        raw: '{"name":"a","name":"b"}',
      })
    ).status
  ).toBe(400);
  expect(
    (
      await f.request("/environments", {
        method: "POST",
        headers: browser,
        raw: '{"name":',
      })
    ).status
  ).toBe(400);
  expect(
    (await f.request("/healthz", { headers: { Host: "other.invalid" } })).status
  ).toBe(401);
  expect(
    (
      await f.request("/api/v1/agents/sessions", {
        method: "POST",
        headers: browser,
        body: { actor: "local-owner" },
      })
    ).status
  ).toBe(401);
  expect((await f.request("/environments")).body).not.toContain("Forbidden");
});

it("fails without port fallback and reports unsafe storage and TLS material", async () => {
  const f = await fixture();
  await f.start();
  await expect(startFleetServer(f.file)).rejects.toThrow(
    /4690|EADDRINUSE|in use|address/i
  );
  f.save({ ...f.input, dataDir: f.root });
  chmodSync(f.root, 0o755);
  await expect(startFleetServer(f.file)).rejects.toThrow(/private|0700/);
  chmodSync(f.root, 0o700);
  f.save({
    ...f.input,
    transport: { mode: "tls", certFile: "missing.pem", keyFile: "key.pem" },
  });
  await expect(startFleetServer(f.file)).rejects.toThrow(
    /TLS.*missing|TLS.*ENOENT/i
  );
});

// The only seeded record is C06's trusted project-ID mapping (#1061 is separate).
// Every transport, authentication, inventory, command and read operation is real.
it("routes authenticated inventory, command claims/results and bounded reads on one listener", async () => {
  const f = await fixture();
  await f.start();
  const browser = await f.browser();
  const created = await f.request("/environments", {
    method: "POST",
    headers: browser,
    body: { name: "Command host" },
  });
  const data = JSON.parse(created.body);
  const token = /id="enrollment-token"[^>]*>([^<]+)<\/textarea>/.exec(
    data.connection
  )![1];
  const enrolled = JSON.parse(
    (
      await f.request("/api/v1/agents/enroll", {
        method: "POST",
        body: { protocolVersion: 1, requestId: randomUUID(), token },
      })
    ).body
  );
  const auth = { Authorization: `Bearer ${enrolled.credential}` };
  const session = JSON.parse(
    (
      await f.request("/api/v1/agents/sessions", {
        method: "POST",
        headers: auth,
        body: {
          protocolVersion: 1,
          requestId: randomUUID(),
          environmentId: enrolled.environmentId,
          agentId: enrolled.agentId,
          agentVersion: "test",
          host: { hostname: "command-test", os: "linux" },
        },
      })
    ).body
  );
  const projectId = randomUUID();
  const database = new DatabaseSync(join(f.input.dataDir, "fleet.sqlite"));
  database
    .prepare(
      "INSERT INTO observed_projects(project_id,environment_id,agent_id,local_project_id) VALUES (?,?,?,?)"
    )
    .run(projectId, enrolled.environmentId, enrolled.agentId, "local");
  database.close();
  const stamp = new Date().toISOString();
  const envelope = () => ({
    protocolVersion: 1,
    requestId: randomUUID(),
    environmentId: enrolled.environmentId,
    sessionId: session.sessionId,
  });
  const observation = {
    ...envelope(),
    sequence: 0,
    observedAt: stamp,
    inventory: {
      revisionId: randomUUID(),
      pageIndex: 0,
      pageCount: 1,
      projects: [
        {
          projectId,
          localProjectId: "local",
          displayName: "Runnable project",
          canonicalPath: "/home/test/project",
          cliVersion: "test",
          validation: { state: "valid" },
          process: { state: "stopped", observedAt: stamp },
          observedAt: stamp,
          runs: [],
        },
      ],
    },
  };
  expect(
    (
      await f.request("/api/v1/agents/observations", {
        method: "POST",
        headers: auth,
        body: observation,
      })
    ).status
  ).toBe(200);
  expect(
    JSON.parse(
      (await f.request(`/environments/${enrolled.environmentId}/connection`))
        .body
    ).connection
  ).toContain("1 projects reported");
  expect((await f.request(`/projects/${projectId}`)).body).toContain(
    "Runnable project"
  );
  expect((await f.request(`/projects/${projectId}/runs`)).status).toBe(200);
  const form = await f.request(`/projects/${projectId}/commands/start`);
  expect(form.status).toBe(200);
  const csrf = /name="csrf" value="([^"]+)"/.exec(form.body)![1];
  const cookie = form.headers["set-cookie"]![0].split(";")[0];
  const submitted = await f.request(`/projects/${projectId}/commands`, {
    method: "POST",
    headers: {
      cookie,
      Origin: f.input.publicOrigin,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    raw: new URLSearchParams({
      csrf,
      operation: "start",
      idempotencyKey: "click",
    }).toString(),
  });
  expect(submitted.status).toBe(303);
  const commandId = submitted.headers.location!.split("/").at(-1)!;
  const pollPath = () =>
    "/api/v1/agents/poll?" +
    new URLSearchParams({ ...envelope(), protocolVersion: "1" }).toString();
  const polled = await f.request(pollPath(), { headers: auth });
  expect(polled.status).toBe(200);
  expect(JSON.parse(polled.body).commands[0].commandId).toBe(commandId);
  expect(
    (
      await f.request(`/api/v1/agents/commands/${commandId}/claim`, {
        method: "POST",
        headers: auth,
        body: { ...envelope(), commandId },
      })
    ).status
  ).toBe(200);
  const result = {
    ...envelope(),
    result: {
      kind: "command",
      commandId,
      state: "succeeded",
      observedAt: stamp,
      evidence: { verified: true },
    },
  };
  expect(
    (
      await f.request("/api/v1/agents/results", {
        method: "POST",
        headers: auth,
        body: result,
      })
    ).status
  ).toBe(200);
  expect((await f.request(`/commands/${commandId}`)).body).toContain(
    "succeeded"
  );
  const read = await f.request(`/api/v1/projects/${projectId}/reads`, {
    method: "POST",
    headers: browser,
    body: { kind: "runs", limit: 10 },
  });
  expect(read.status).toBe(202);
  const readId = JSON.parse(read.body).readId;
  const readPoll = JSON.parse(
    (await f.request(pollPath(), { headers: auth })).body
  );
  expect(readPoll.reads[0].readId).toBe(readId);
  expect(
    (
      await f.request("/api/v1/agents/results", {
        method: "POST",
        headers: auth,
        body: {
          ...envelope(),
          result: {
            kind: "read",
            result: {
              readId,
              state: "completed",
              completedAt: stamp,
              payload: { kind: "runs", runs: [] },
            },
          },
        },
      })
    ).status
  ).toBe(200);
  expect(
    JSON.parse((await f.request(`/api/v1/reads/${readId}`)).body).state
  ).toBe("completed");
  expect(
    (
      await f.request(`/environments/${enrolled.environmentId}/revoke`, {
        method: "POST",
        headers: browser,
        body: { acknowledged: true },
      })
    ).status
  ).toBe(200);
  expect((await f.request(pollPath(), { headers: auth })).status).toBe(401);
});

it("closes stalled TLS handshakes within the shutdown deadline", async () => {
  const f = await fixture();
  const server = await f.start();
  const peer = connect(f.input.port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    peer.once("connect", resolve);
    peer.once("error", reject);
  });
  // Allow the server's connection callback to run without sending TLS bytes.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const closing = server.close();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closedInTime = false;
  try {
    closedInTime = await Promise.race([
      closing.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 6_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    peer.destroy();
    await closing;
  }
  expect(closedInTime).toBe(true);
}, 8_000);
