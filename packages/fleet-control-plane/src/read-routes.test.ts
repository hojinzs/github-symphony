import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createBrowserSecurity } from "./browser-security.js";
import { createReadService } from "./reads.js";
import { createReadRoutes } from "./read-routes.js";
import { openFleetStore } from "./store.js";
import { commandPeers } from "../test-fixtures/command-peers.js";

it("routes read acceptance and details with CSRF and structured errors", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-read-routes-")));
  const store = openFleetStore(dir);
  try {
    const f = await commandPeers(store, () => new Date());
    const api = createReadService(store, { peers: f.peers });
    const browser = createBrowserSecurity({
      publicOrigin: "https://fleet.example",
    });
    const session = browser.issueSession();
    const handle = createReadRoutes(api, browser);
    const request = {
      method: "POST",
      pathname: `/api/v1/projects/${f.project()}/reads`,
      body: { kind: "runs", limit: 1 },
      origin: "https://fleet.example",
      cookie: session.setCookie.split(";")[0],
      csrfToken: session.csrfToken,
    };
    expect(await handle({ ...request, csrfToken: "wrong" })).toMatchObject({
      status: 401,
      body: {
        error: { code: "unauthenticated", requestId: expect.any(String) },
      },
    });
    const accepted = await handle(request);
    expect(accepted).toMatchObject({
      status: 202,
      body: { state: "pending", readId: expect.any(String) },
    });
    const readId = (accepted!.body as { readId: string }).readId;
    expect(
      await handle({ method: "GET", pathname: `/api/v1/reads/${readId}` })
    ).toMatchObject({
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "X-Symphony-Historical": "false",
      },
      body: { readId, state: "pending" },
    });
    expect(await handle(request)).toMatchObject({
      status: 409,
      body: { error: { code: "read_busy" } },
    });
    expect(
      await handle({
        ...request,
        body: {
          kind: "log-chunk",
          runId: "run",
          stream: "../../secret",
          maxBytes: 1,
        },
      })
    ).toMatchObject({
      status: 400,
      body: { error: { code: "invalid_input" } },
    });
    expect(
      await handle({ method: "GET", pathname: `/api/v1/reads/${randomUUID()}` })
    ).toMatchObject({ status: 200, body: { state: "unavailable" } });
    expect(
      await handle({ method: "GET", pathname: "/api/v1/commands/other" })
    ).toBeUndefined();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
