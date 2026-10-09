import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:https";
import {
  mkdtemp,
  readFile,
  writeFile,
  realpath,
  rm,
  chmod,
  link,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { afterEach, beforeEach, expect, it } from "vitest";
import type {
  AgentEnvelope,
  EnrollmentResponse,
} from "@gh-symphony/management-protocol";
import { AgentRegistry } from "./registry.js";
import {
  agentServerOrigin,
  createAgentTransport,
  enrollAgent,
} from "./transport.js";

let root: string;
let registry: AgentRegistry;
let server: Server;
let origin: string;
let ca: string;
let reply: (body: Record<string, unknown>) => Record<string, unknown>;
let status: number;
let requests: { path: string; auth?: string; body: Record<string, unknown> }[];
const enrollment: EnrollmentResponse = {
  protocolVersion: 1,
  requestId: randomUUID(),
  environmentId: randomUUID(),
  agentId: randomUUID(),
  credential: "fixture-only-secret",
};
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "c05-transport-")));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(root, "key"),
      "-out",
      join(root, "cert"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost",
    ],
    { stdio: "ignore" }
  );
  ca = await readFile(join(root, "cert"), "utf8");
  registry = await AgentRegistry.open(join(root, "agent"));
  requests = [];
  status = 200;
  reply = (body) => ({ ...body, commands: [], reads: [] });
  server = createServer(
    { key: await readFile(join(root, "key")), cert: ca },
    async (req, res) => {
      const url = new URL(req.url!, "https://localhost");
      let raw = "";
      for await (const chunk of req) raw += String(chunk);
      const body = raw ? JSON.parse(raw) : Object.fromEntries(url.searchParams);
      if (!raw) body.protocolVersion = Number(body.protocolVersion);
      requests.push({
        path: url.pathname,
        auth: req.headers.authorization,
        body,
      });
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply(body)));
    }
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `https://localhost:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await registry.close();
  await rm(root, { recursive: true, force: true });
});
function client() {
  return createAgentTransport({
    serverOrigin: origin,
    ca,
    identity: () => registry.identity,
  });
}
function envelope(): AgentEnvelope {
  return {
    protocolVersion: 1,
    requestId: randomUUID(),
    environmentId: enrollment.environmentId,
    sessionId: randomUUID(),
  };
}
it("exchanges once, persists identity and resumes without a token or allowlist change", async () => {
  reply = (body) => ({ ...enrollment, requestId: body.requestId });
  const saved = await enrollAgent(registry, client(), origin, "fixture-token");
  expect(saved.credential).toBe(enrollment.credential);
  expect(requests[0].auth).toBeUndefined();
  expect(requests[0].path).toBe("/api/v1/agents/enroll");
  await registry.close();
  registry = await AgentRegistry.open(join(root, "agent"));
  await enrollAgent(registry, client(), origin, "");
  expect(requests).toHaveLength(1);
  await expect(
    enrollAgent(registry, client(), "https://other.example", "")
  ).rejects.toThrow("identity_server_mismatch");
});
it("sends a schema-validated session-scoped GET with origin-only bearer authentication", async () => {
  await registry.saveIdentity(origin, enrollment);
  const input = envelope();
  expect(await client().poll(input)).toEqual({
    ...input,
    commands: [],
    reads: [],
  });
  expect(requests[0].auth).toBe(`Bearer ${enrollment.credential}`);
  expect(requests[0].path).toBe("/api/v1/agents/poll");
  expect(JSON.stringify(requests[0].body)).not.toContain(enrollment.credential);
});
it("rejects foreign response ownership and malformed protocol replies", async () => {
  await registry.saveIdentity(origin, enrollment);
  reply = (body) => ({
    ...body,
    sessionId: randomUUID(),
    commands: [],
    reads: [],
  });
  await expect(client().poll(envelope())).rejects.toThrow(
    "response_identity_mismatch"
  );
  reply = () => ({ protocolVersion: 2 });
  await expect(client().poll(envelope())).rejects.toThrow("unexpected literal");
});
it("rejects redirects and suppresses server messages containing secrets", async () => {
  await registry.saveIdentity(origin, enrollment);
  status = 302;
  await expect(client().poll(envelope())).rejects.toThrow("redirect_rejected");
  status = 401;
  reply = () => ({
    error: {
      code: "unauthenticated",
      message: enrollment.credential,
      requestId: randomUUID(),
    },
  });
  await expect(client().poll(envelope())).rejects.toThrow(
    /^Management transport: unauthenticated$/
  );
});
it("bounds response bytes and enforces an absolute deadline and cancellation", async () => {
  await registry.saveIdentity(origin, enrollment);
  reply = () => ({ padding: "x".repeat(4 * 1024 * 1024) });
  await expect(client().poll(envelope())).rejects.toThrow("response_too_large");
  server.removeAllListeners("request");
  server.on("request", (_req, res) => {
    res.writeHead(200);
    res.write("{");
  });
  await expect(
    createAgentTransport({
      serverOrigin: origin,
      ca,
      identity: () => registry.identity,
      timeoutMs: 20,
    }).poll(envelope())
  ).rejects.toThrow("request_timeout");
  const controller = new AbortController();
  controller.abort();
  await expect(
    createAgentTransport({
      serverOrigin: origin,
      ca,
      identity: () => registry.identity,
      signal: controller.signal,
    }).poll(envelope())
  ).rejects.toThrow("aborted");
});
it("rejects insecure origins and unsafe credential paths without repairing permissions", async () => {
  expect(agentServerOrigin("https://control.example/")).toBe(
    "https://control.example"
  );
  for (const input of [
    "http://control.example",
    "https://user:secret@control.example",
    "https://control.example/path",
    "https://control.example?token=secret",
  ])
    expect(() => agentServerOrigin(input)).toThrow("invalid_server_origin");
  await registry.saveIdentity(origin, enrollment);
  await registry.close();
  const path = join(root, "agent", "registry.json");
  await chmod(path, 0o644);
  await expect(AgentRegistry.open(join(root, "agent"))).rejects.toThrow(
    "user-only"
  );
  await chmod(path, 0o600);
  await link(path, join(root, "hardlink"));
  await expect(AgentRegistry.open(join(root, "agent"))).rejects.toThrow(
    "user-only"
  );
  await rm(join(root, "hardlink"));
  await symlink(join(root, "agent"), join(root, "alias"));
  await expect(AgentRegistry.open(join(root, "alias"))).rejects.toThrow(
    "user-owned"
  );
  await chmod(join(root, "agent"), 0o755);
  await expect(AgentRegistry.open(join(root, "agent"))).rejects.toThrow(
    "user-owned"
  );
});

it("suppresses credential bytes from malformed persisted JSON diagnostics", async () => {
  await registry.close();
  await writeFile(
    join(root, "agent", "registry.json"),
    "fixture-only-private-value",
    { mode: 0o600 }
  );
  await expect(AgentRegistry.open(join(root, "agent"))).rejects.toThrow(
    /^Invalid agent registry$/
  );
});

it("rejects an untrusted TLS peer before sending its bearer credential", async () => {
  await registry.saveIdentity(origin, enrollment);
  await expect(
    createAgentTransport({
      serverOrigin: origin,
      identity: () => registry.identity,
    }).poll(envelope())
  ).rejects.toThrow("network_failure");
  expect(requests).toEqual([]);
});
