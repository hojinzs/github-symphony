import { appendFile, mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { OrchestratorFsStore } from "./fs-store.js";

describe("OrchestratorFsStore.loadRecentRunEvents", () => {
  it("returns the most recent formatted events in order", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-store-"));
    const store = new OrchestratorFsStore(runtimeRoot);

    await store.appendRunEvent("run-1", {
      at: "2026-03-16T00:00:00.000Z",
      event: "run-dispatched",
      projectId: "project-1",
      issueIdentifier: "acme/repo#1",
      issueState: "Todo",
    });
    await store.appendRunEvent("run-1", {
      at: "2026-03-16T00:01:00.000Z",
      event: "worker-error",
      runId: "run-1",
      issueIdentifier: "acme/repo#1",
      error: "worker failed",
      attempt: 1,
    });

    const events = await store.loadRecentRunEvents("run-1", 1);

    expect(events).toEqual([
      {
        at: "2026-03-16T00:01:00.000Z",
        event: "worker-error",
        message: "worker failed",
      },
    ]);
  });

  it("returns an empty array when the event log does not exist", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-store-"));
    const store = new OrchestratorFsStore(runtimeRoot);

    await expect(store.loadRecentRunEvents("missing-run")).resolves.toEqual([]);
  });

  it("skips corrupted trailing lines and returns the latest valid events", async () => {
    const runtimeRoot = await mkdtemp(join(tmpdir(), "orchestrator-store-"));
    const store = new OrchestratorFsStore(runtimeRoot);
    const path = join(store.runDir("run-1"), "events.ndjson");
    await mkdir(store.runDir("run-1"), { recursive: true });

    await appendFile(
      path,
      [
        JSON.stringify({
          at: "2026-03-16T00:00:00.000Z",
          event: "run-dispatched",
          projectId: "project-1",
          issueIdentifier: "acme/repo#1",
          issueState: "Todo",
        }),
        "{\"bad\":",
        JSON.stringify({
          at: "2026-03-16T00:01:00.000Z",
          event: "worker-error",
          runId: "run-1",
          issueIdentifier: "acme/repo#1",
          error: "worker failed",
          attempt: 1,
        }),
        "",
      ].join("\n"),
      "utf8"
    );

    await expect(store.loadRecentRunEvents("run-1", 2)).resolves.toEqual([
      {
        at: "2026-03-16T00:00:00.000Z",
        event: "run-dispatched",
        message: "Dispatched from Todo",
      },
      {
        at: "2026-03-16T00:01:00.000Z",
        event: "worker-error",
        message: "worker failed",
      },
    ]);
  });
});
