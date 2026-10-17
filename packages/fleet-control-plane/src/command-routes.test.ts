import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createBrowserSecurity } from "./browser-security.js";
import { createCommandService } from "./commands.js";
import {
  createCommandRoutes,
  type CommandRouteRequest,
} from "./command-routes.js";
import { openFleetStore } from "./store.js";
import { commandPeers } from "../test-fixtures/command-peers.js";
import type { CommandContext } from "./command-pages.js";
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
async function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "command-ui-")));
  const store = openFleetStore(dir);
  cleanup.push(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let clock = Date.parse("2026-10-16T09:00:00Z");
  const now = () => new Date(clock);
  const peer = await commandPeers(store, now);
  const projectId = peer.project();
  const commands = createCommandService(store, { peers: peer.peers, now });
  const browser = createBrowserSecurity(
    { publicOrigin: "https://fleet.test" },
    { now: () => clock }
  );
  const context: CommandContext = {
    environment: "Linux",
    disabledReasons: {},
    project: {
      projectId,
      environmentId: peer.identity.environmentId,
      localProjectId: "prepared",
      managed: true,
      connection: "online",
      fresh: true,
      snapshotStale: false,
      lastReceivedAt: now().toISOString(),
      warnings: [],
      observation: {
        projectId,
        localProjectId: "prepared",
        displayName: "Prepared",
        canonicalPath: "/prepared",
        cliVersion: "1.0.0",
        validation: { state: "valid" },
        process: {
          state: "running",
          identity: "original",
          pid: 42,
          observedAt: now().toISOString(),
        },
        observedAt: now().toISOString(),
        snapshot: { summary: { activeRuns: 2 } },
        runs: [],
      },
    },
  };
  const routes = createCommandRoutes(commands, browser, {
    context: async () => context,
    now: () => clock,
  });
  const session = browser.issueSession();
  const post = (
    pathname: string,
    body: Record<string, string>,
    overrides: Partial<CommandRouteRequest> = {}
  ) =>
    routes({
      method: "POST",
      pathname,
      origin: "https://fleet.test",
      cookie: session.setCookie.split(";")[0],
      body: { csrf: session.csrfToken, ...body },
      ...overrides,
    });
  const envelope = () => ({
    protocolVersion: 1 as const,
    environmentId: peer.identity.environmentId,
    sessionId: peer.identity.sessionId,
    requestId: randomUUID(),
  });
  return {
    store,
    commands,
    routes,
    context,
    projectId,
    post,
    peer,
    envelope,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
it("requires same-origin CSRF and current eligibility before durable submission", async () => {
  const f = await fixture();
  const path = `/projects/${f.projectId}/commands`;
  const input = { operation: "stop", idempotencyKey: "one" };
  expect(
    (await f.post(path, input, { origin: "https://evil.test" }))?.status
  ).toBe(401);
  expect((await f.post(path, input, { cookie: undefined }))?.status).toBe(401);
  f.context.project.fresh = false;
  expect((await f.post(path, input))?.body).toContain("Observation is stale");
  expect(
    (await f.commands.listCommands(f.projectId, { limit: 25 })).items
  ).toHaveLength(0);
  f.context.project.fresh = true;
  const submitted = await f.post(path, input);
  expect(submitted?.status).toBe(303);
  expect(submitted?.headers.Location).toMatch(/^\/commands\//);
  expect((await f.post(path, input))?.headers.Location).toBe(
    submitted?.headers.Location
  );
  expect(
    (await f.commands.listCommands(f.projectId, { limit: 25 })).items
  ).toHaveLength(1);
  expect(f.context.project.observation.process.state).toBe("running");
  expect(
    (await f.post(path, { operation: "stop", idempotencyKey: "new" }))?.status
  ).toBe(409);
});
it("keeps GET inert, validates route inputs and renders pending separately from observations", async () => {
  const f = await fixture();
  const path = `/projects/${f.projectId}/commands`;
  const confirmation = await f.routes({
    method: "GET",
    pathname: path + "/stop",
  });
  expect(confirmation?.body).toContain("Stopping interrupts active runs");
  expect(confirmation?.headers["Set-Cookie"]).toContain("HttpOnly");
  expect(
    (await f.commands.listCommands(f.projectId, { limit: 25 })).items
  ).toHaveLength(0);
  expect(
    (await f.routes({ method: "GET", pathname: path + "?cursor=a&cursor=b" }))
      ?.status
  ).toBe(400);
  expect(
    (await f.routes({ method: "GET", pathname: "/commands/invalid" }))?.status
  ).toBe(400);
  expect((await f.routes({ method: "DELETE", pathname: path }))?.status).toBe(
    405
  );
  expect(
    await f.routes({ method: "GET", pathname: "/unrelated" })
  ).toBeUndefined();
  expect(
    (await f.post(path, { operation: "kill", idempotencyKey: "bad" }))?.status
  ).toBe(400);
  const row = await f.commands.submitCommand(f.projectId, "one", {
    operation: "stop",
  });
  const html = await f.routes({
    method: "GET",
    pathname: `/commands/${row.commandId}`,
  });
  expect(html?.body).toContain("stop · accepted");
  expect(html?.body).toContain("running · online");
  expect(html?.headers["Cache-Control"]).toBe("no-store");
  expect((await f.routes({ method: "GET", pathname: path }))?.body).toContain(
    row.commandId
  );
});
it("enforces required reason, reviewed second confirmation, expiry and durable unknown audit", async () => {
  const f = await fixture();
  const submitted = await f.commands.submitCommand(f.projectId, "unknown", {
    operation: "stop",
  });
  await f.commands.claim(f.peer.identity, {
    ...f.envelope(),
    commandId: submitted.commandId,
  });
  f.advance(60_001);
  expect((await f.commands.getCommand(submitted.commandId)).state).toBe(
    "unknown"
  );
  const path = `/commands/${submitted.commandId}`;
  expect(
    (
      await f.post(path + "/close-unresolved", {
        reason: "inspected",
        acknowledge: "true",
      })
    )?.status
  ).toBe(400);
  expect(
    (await f.post(path + "/closure-confirmation", { reason: " " }))?.status
  ).toBe(400);
  const review = await f.post(path + "/closure-confirmation", {
    reason: "Inspected local process",
  });
  expect(review?.status).toBe(200);
  const token = /name="review" value="([^"]+)"/.exec(review!.body)![1];
  expect(
    (await f.commands.getCommand(submitted.commandId)).closure
  ).toBeUndefined();
  expect(
    (
      await f.post(path + "/close-unresolved", {
        reason: "changed",
        acknowledge: "true",
        review: token,
      })
    )?.status
  ).toBe(400);
  f.advance(300_000);
  expect(
    (
      await f.post(path + "/close-unresolved", {
        reason: "Inspected local process",
        acknowledge: "true",
        review: token,
      })
    )?.status
  ).toBe(400);
  const renewed = await f.post(path + "/closure-confirmation", {
    reason: "Inspected local process",
  });
  const renewedToken = /name="review" value="([^"]+)"/.exec(renewed!.body)![1];
  expect(
    (
      await f.post(path + "/close-unresolved", {
        reason: "Inspected local process",
        acknowledge: "true",
        review: renewedToken,
      })
    )?.status
  ).toBe(303);
  const final = await f.commands.getCommand(submitted.commandId);
  expect(final.state).toBe("unknown");
  expect(final.closure).toMatchObject({
    actor: "local-owner",
    reason: "Inspected local process",
  });
  expect(
    f.store.database
      .prepare(
        "SELECT operation FROM audit_records WHERE operation='command.close-unresolved'"
      )
      .all()
  ).toHaveLength(1);
  expect((await f.routes({ method: "GET", pathname: path }))?.body).toContain(
    "Closed unresolved · outcome unknown"
  );
});

it("preserves two-tab forms and closure cancellation until the session expires", async () => {
  const f = await fixture();
  const path = `/projects/${f.projectId}/commands`;
  const first = (await f.routes({ method: "GET", pathname: path + "/stop" }))!;
  const csrf = /name="csrf" value="([^"]+)"/.exec(first.body)![1];
  const cookie = first.headers["Set-Cookie"].split(";")[0];
  // More than registry capacity worth of browsing must not evict this session.
  for (let i = 0; i < 260; i++) {
    const other = await f.routes({
      method: "GET",
      pathname: path + "/start",
      cookie,
    });
    expect(other?.headers["Set-Cookie"].split(";")[0]).toBe(cookie);
    expect(other?.body).toContain(`name="csrf" value="${csrf}"`);
  }
  const submitted = await f.post(
    path,
    { csrf, operation: "stop", idempotencyKey: "two-tabs" },
    { cookie }
  );
  expect(submitted?.status).toBe(303);
  const commandPath = submitted!.headers.Location;
  const commandId = commandPath.split("/").at(-1)!;
  await f.commands.claim(f.peer.identity, { ...f.envelope(), commandId });
  f.advance(60_001);
  const reviewed = await f.post(
    commandPath + "/closure-confirmation",
    { csrf, reason: "Inspected" },
    { cookie }
  );
  const review = /name="review" value="([^"]+)"/.exec(reviewed!.body)![1];
  const cancelled = await f.routes({
    method: "GET",
    pathname: commandPath,
    cookie,
  });
  expect(cancelled?.headers["Set-Cookie"].split(";")[0]).toBe(cookie);
  expect(
    (
      await f.post(
        commandPath + "/close-unresolved",
        { csrf, reason: "Inspected", acknowledge: "true", review },
        { cookie }
      )
    )?.status
  ).toBe(303);
  f.advance(8 * 60 * 60_000);
  const fresh = await f.routes({
    method: "GET",
    pathname: path + "/stop",
    cookie,
  });
  expect(fresh?.headers["Set-Cookie"].split(";")[0]).not.toBe(cookie);
  expect(
    (
      await f.post(
        path,
        { csrf, operation: "stop", idempotencyKey: "expired" },
        { cookie }
      )
    )?.status
  ).toBe(401);
});

it("rejects oversized UTF-8 reasons before review and accepts the exact byte boundary", async () => {
  const f = await fixture();
  const submitted = await f.commands.submitCommand(f.projectId, "byte-limit", {
    operation: "stop",
  });
  await f.commands.claim(f.peer.identity, {
    ...f.envelope(),
    commandId: submitted.commandId,
  });
  f.advance(60_001);
  const path = `/commands/${submitted.commandId}`;
  for (const reason of ["a".repeat(2049), "é".repeat(1025)]) {
    const rejected = await f.post(path + "/closure-confirmation", { reason });
    expect(rejected?.status).toBe(400);
    expect(rejected?.body).not.toContain('name="review"');
  }
  const reason = "é".repeat(1024);
  const accepted = await f.post(path + "/closure-confirmation", { reason });
  expect(accepted?.status).toBe(200);
  const review = /name="review" value="([^"]+)"/.exec(accepted!.body)![1];
  expect(
    (
      await f.post(path + "/close-unresolved", {
        reason,
        acknowledge: "true",
        review,
      })
    )?.status
  ).toBe(303);
  expect(
    (await f.commands.getCommand(submitted.commandId)).closure?.reason
  ).toBe(reason);
});
