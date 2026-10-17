import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { openFleetStore } from "./store.js";
import { commandPeers } from "../test-fixtures/command-peers.js";
import { createReadService } from "./reads.js";
import { createBrowserSecurity } from "./browser-security.js";
import { createReadRoutes } from "./read-routes.js";
import { RunLogModel } from "./run-log-model.js";
import { BoundedLogReader } from "./log-read-client.js";

it("uses actual C10 acceptance and result routes, retaining cursor and explicit reset", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "c18-reader-")));
  const store = openFleetStore(root);
  try {
    const peer = await commandPeers(store, () => new Date());
    const projectId = peer.project();
    const reads = createReadService(store, { peers: peer.peers });
    const browser = createBrowserSecurity({
      publicOrigin: "https://fleet.example",
    });
    const session = browser.issueSession();
    const routes = createReadRoutes(reads, browser);
    const model = new RunLogModel(
      {
        environmentId: peer.identity.environmentId,
        projectId,
        runId: "known",
        stream: "worker",
      },
      ["known"]
    );
    let rotate = false;
    const selections: unknown[] = [];
    const fetcher: typeof fetch = async function (this: unknown, input, init) {
      if (this !== globalThis)
        throw new TypeError("Native fetch receiver required");
      const path = String(input);
      const result = await routes({
        method: init?.method ?? "GET",
        pathname: path,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        cookie: session.setCookie.split(";")[0],
        origin: "https://fleet.example",
        csrfToken: new Headers(init?.headers).get("X-CSRF-Token") ?? undefined,
      });
      if (init?.method === "POST" && result?.status === 202) {
        const request = reads.poll(peer.identity)[0];
        selections.push(request.selection);
        await reads.publishResult(peer.identity, {
          protocolVersion: 1,
          requestId: crypto.randomUUID(),
          environmentId: peer.identity.environmentId,
          sessionId: peer.identity.sessionId,
          result: {
            kind: "read",
            result: {
              readId: request.readId,
              state: "completed",
              completedAt: new Date().toISOString(),
              payload: {
                kind: "log-chunk",
                runId: "known",
                stream: "worker",
                text: "<script>text only</script>",
                cursor: "opaque",
                reset: rotate,
                eof: true,
              },
            },
          },
        });
      }
      return new Response(JSON.stringify(result?.body), {
        status: result?.status,
        headers: result?.headers,
      });
    };
    const reader = new BoundedLogReader(model, session.csrfToken, fetcher);
    await reader.read();
    expect(model.text).toBe("<script>text only</script>");
    expect(model.phase).toBe("ready");
    rotate = true;
    await reader.read();
    expect(model.phase).toBe("reset-required");
    expect(model.text).toBe("<script>text only</script>");
    expect(selections).toEqual([
      { kind: "log-chunk", runId: "known", stream: "worker", maxBytes: 262144 },
      {
        kind: "log-chunk",
        runId: "known",
        stream: "worker",
        maxBytes: 262144,
        cursor: "opaque",
      },
    ]);
    await reader.read();
    expect(selections).toHaveLength(2);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("expires a hung request after 30 seconds and rejects its late completion", async () => {
  vi.useFakeTimers();
  try {
    const model = new RunLogModel(
      {
        environmentId: "env",
        projectId: "project",
        runId: "known",
        stream: "worker",
      },
      ["known"]
    );
    const fetcher: typeof fetch = (_url, init) =>
      new Promise((_resolve, reject) =>
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true }
        )
      );
    const reader = new BoundedLogReader(model, "csrf", fetcher);
    const pending = reader.read();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(model.phase).toBe("loading");
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(model.phase).toBe("expired");
    expect(model.following).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

it("pauses follow immediately on network loss and agent-offline responses", async () => {
  for (const failure of ["network", "http", "result"]) {
    const model = new RunLogModel(
      {
        environmentId: "env",
        projectId: "project",
        runId: "known",
        stream: "worker",
      },
      ["known"]
    );
    model.follow();
    let call = 0;
    const readId = crypto.randomUUID();
    const fetcher: typeof fetch = async () => {
      if (failure === "network") throw new Error("connection lost");
      if (failure === "http")
        return new Response(
          JSON.stringify({ error: { code: "agent_offline" } }),
          { status: 409 }
        );
      return new Response(
        JSON.stringify(
          call++ === 0
            ? { readId }
            : {
                readId,
                state: "unavailable",
                diagnostic: { code: "agent_offline", message: "Offline" },
              }
        )
      );
    };
    await new BoundedLogReader(model, "csrf", fetcher).read();
    expect(model.phase).toBe("offline");
    expect(model.following).toBe(false);
    expect(model.historical).toBe(true);
  }
});

it("distinguishes an expired actual browser session and requires reload without losing text", async () => {
  let now = Date.now();
  const browser = createBrowserSecurity(
    { publicOrigin: "https://fleet.example" },
    { now: () => now, sessionLifetimeMs: 1000 }
  );
  const session = browser.issueSession();
  const routes = createReadRoutes({} as never, browser);
  const model = new RunLogModel(
    {
      environmentId: "env",
      projectId: crypto.randomUUID(),
      runId: "known",
      stream: "worker",
    },
    ["known"]
  );
  model.text = "previously fetched";
  model.fetchedAt = new Date(now).toISOString();
  const fetchedAt = model.fetchedAt;
  model.follow();
  now += 1000;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const result = await routes({
      method: "POST",
      pathname: String(input),
      body: JSON.parse(String(init?.body)),
      cookie: session.setCookie.split(";")[0],
      origin: "https://fleet.example",
      csrfToken: new Headers(init?.headers).get("X-CSRF-Token") ?? undefined,
    });
    expect(result?.status).toBe(401);
    return new Response(JSON.stringify(result?.body), {
      status: result?.status,
    });
  });
  const reader = new BoundedLogReader(model, session.csrfToken, fetcher);
  await reader.read();
  expect(model.phase).toBe("session-expired");
  expect(model.text).toBe("previously fetched");
  expect(model.fetchedAt).toBe(fetchedAt);
  expect(model.historical).toBe(true);
  expect(model.following).toBe(false);
  model.disconnect();
  model.reconnect();
  model.reset();
  model.follow();
  await reader.read();
  expect(model.phase).toBe("session-expired");
  expect(model.following).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
