import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { OrchestratorFsStore } from "../fs-store.js";
import { createLogPipeline } from "./log-pipeline.js";

it("OT-04/12: durable append completes while transport stalls without diagnostic append recursion", async () => {
  const root = await mkdtemp(join(tmpdir(), "symphony-993-publication-"));
  // Keep filesystem I/O real, but expire the drain only after both durable
  // appends complete. A wall-clock deadline races disk latency in the full suite.
  vi.useFakeTimers({
    toFake: [
      "Date",
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
    ],
  });
  let transportStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    transportStarted = resolve;
  });
  const diagnostic = vi.fn();
  let calls = 0;
  const pipeline = createLogPipeline(
    {
      version: "test",
      projectId: "p",
      projectSlug: "o/r",
      trackerKind: "file",
    },
    { endpoint: "http://receiver/v1/logs", headers: {} },
    {
      request: async (_target, _bytes, signal) => {
        calls++;
        transportStarted();
        return new Promise((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new Error("secret echo")),
            { once: true }
          )
        );
      },
      diagnostic,
    }
  );
  const store = new OrchestratorFsStore(root, { publication: pipeline });
  try {
    await mkdir(store.runDir("r", "p"), { recursive: true });
    await store.appendRunEvent("r", {
      at: "2026-10-07T00:00:00Z",
      event: "run-failed",
      projectId: "p",
      issueIdentifier: "o/r#1",
      attempt: 1,
      lastError: "redacted",
    });
    const flushing = pipeline.flush(Date.now() + 30);
    await started;
    expect(calls).toBe(1);
    await store.appendRunEvent("r", {
      at: "2026-10-07T00:00:01Z",
      event: "run-failed",
      projectId: "p",
      issueIdentifier: "o/r#1",
      attempt: 2,
      lastError: "redacted",
    });
    const lines = (
      await readFile(join(store.runDir("r", "p"), "events.ndjson"), "utf8")
    )
      .trim()
      .split("\n");
    expect(lines).toHaveLength(2);
    expect(
      lines.every((line) => JSON.parse(line).integrity.startsWith("sha256:"))
    ).toBe(true);
    expect(pipeline.status()).toMatchObject({
      records: 2,
      dropped: { shutdown: 0 },
    });
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(30);
    await flushing;
    expect(pipeline.status()).toMatchObject({
      records: 0,
      dropped: { shutdown: 2 },
    });
    await pipeline.shutdown(Date.now());
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
      signal: "logs",
      category: "shutdown",
      state: "failure",
      lost: 2,
    });
    expect(
      await readFile(join(store.runDir("r", "p"), "events.ndjson"), "utf8")
    ).toBe(lines.join("\n") + "\n");
  } finally {
    await pipeline.shutdown(Date.now());
    vi.useRealTimers();
    await rm(root, { recursive: true, force: true });
  }
});
