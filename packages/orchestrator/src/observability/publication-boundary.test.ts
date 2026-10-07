import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { OrchestratorFsStore } from "../fs-store.js";
import { createLogPipeline } from "./log-pipeline.js";

it("OT-04/12: durable append completes while transport stalls without diagnostic append recursion", async () => {
  const root = await mkdtemp(join(tmpdir(), "symphony-993-publication-"));
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
        return new Promise((_resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new Error("secret echo")),
            { once: true }
          )
        );
      },
      diagnostic: () => {},
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
    await new Promise((resolve) => setImmediate(resolve));
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
    await flushing;
    expect(pipeline.status()).toMatchObject({
      records: 0,
      dropped: { shutdown: 2 },
    });
  } finally {
    await pipeline.shutdown(Date.now());
    await rm(root, { recursive: true, force: true });
  }
});
