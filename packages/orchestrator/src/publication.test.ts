import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  redactObservabilitySecrets,
  type OrchestratorEvent,
} from "@gh-symphony/core";
import { OrchestratorFsStore } from "./fs-store.js";
import { offerBestEffort } from "./publication.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function root() {
  const result = await mkdtemp(join(tmpdir(), "publication-"));
  roots.push(result);
  return result;
}
const event: OrchestratorEvent = {
  at: "2026-10-05T00:00:00.000Z",
  event: "run-failed",
  projectId: "project-1",
  issueIdentifier: "acme/repo#1",
  error: "token=ghp_abcdefghijklmnopqrstuvwxyz1234567890",
  attempt: 1,
};

describe("OT-07 durable publication", () => {
  it("offers immutable redacted events after primary and mirror with unchanged bytes and integrity", async () => {
    const runtimeRoot = await root();
    const mirror = join(runtimeRoot, "mirror");
    const baseline = new OrchestratorFsStore(join(runtimeRoot, "baseline"));
    await baseline.appendRunEvent("append-owner", event);
    let offered: unknown;
    let bytesAtOffer: string[] = [];
    const offerEvent = vi.fn((value, context) => {
      offered = { value, context };
      bytesAtOffer = [
        readFileSync(
          join(store.runDir("append-owner", "project-1"), "events.ndjson"),
          "utf8"
        ),
        readFileSync(
          join(mirror, "projects/project-1/runs/append-owner/events.ndjson"),
          "utf8"
        ),
      ];
    });
    const store = new OrchestratorFsStore(join(runtimeRoot, "primary"), {
      eventsMirrorRoot: mirror,
      publication: { offerEvent },
    });
    await store.appendRunEvent("append-owner", event);
    const bytes = await readFile(
      join(store.runDir("append-owner", "project-1"), "events.ndjson"),
      "utf8"
    );
    expect(bytes).toBe(
      await readFile(
        join(baseline.runDir("append-owner", "project-1"), "events.ndjson"),
        "utf8"
      )
    );
    expect(bytes).toBe(
      await readFile(
        join(mirror, "projects/project-1/runs/append-owner/events.ndjson"),
        "utf8"
      )
    );
    expect(bytesAtOffer).toEqual([bytes, bytes]);
    const integrity = `sha256:${createHash("sha256")
      .update(JSON.stringify(redactObservabilitySecrets(event)))
      .digest("hex")}`;
    expect(JSON.parse(bytes).integrity).toBe(integrity);
    expect(offerEvent).toHaveBeenCalledOnce();
    expect(offered).toEqual({
      value: redactObservabilitySecrets(event),
      context: {
        observedAt: expect.any(String),
        projectId: "project-1",
        runId: "append-owner",
        integrity,
      },
    });
    const [value, context] = offerEvent.mock.calls[0];
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(context)).toBe(true);
    expect(() => {
      value.error = "changed";
    }).toThrow();
    expect(event.error).toContain("ghp_");
  });

  it("offers once after a failed mirror and contains a throwing callback", async () => {
    const runtimeRoot = await root();
    const mirror = join(runtimeRoot, "mirror-file");
    await writeFile(mirror, "unavailable");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let warningsAtOffer = 0;
    const offerEvent = vi.fn(() => {
      warningsAtOffer = warn.mock.calls.length;
      throw new Error("export secret");
    });
    const store = new OrchestratorFsStore(runtimeRoot, {
      eventsMirrorRoot: mirror,
      publication: { offerEvent },
    });
    await expect(store.appendRunEvent("run-1", event)).resolves.toBeUndefined();
    expect(offerEvent).toHaveBeenCalledOnce();
    expect(
      await readFile(
        join(store.runDir("run-1", "project-1"), "events.ndjson"),
        "utf8"
      )
    ).toContain('"integrity":');
    expect(warn).toHaveBeenCalledOnce();
    expect(warningsAtOffer).toBe(1);
  });

  it("offers nothing on primary append failure", async () => {
    const runtimeRoot = await root();
    const offerEvent = vi.fn();
    const store = new OrchestratorFsStore(runtimeRoot, {
      publication: { offerEvent },
    });
    await mkdir(join(store.runDir("run-1", "project-1"), "events.ndjson"), {
      recursive: true,
    });
    await expect(store.appendRunEvent("run-1", event)).rejects.toThrow();
    expect(offerEvent).not.toHaveBeenCalled();
  });
});

it("OT-04/12 contains sync throws, async rejection and pending callbacks without awaiting or diagnostics", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  expect(() =>
    offerBestEffort(() => {
      throw new Error("secret");
    })
  ).not.toThrow();
  offerBestEffort(() => Promise.reject(new Error("secret")));
  const pending = new Promise(() => {});
  expect(offerBestEffort(() => pending)).toBeUndefined();
  await Promise.resolve();
  expect(warn).not.toHaveBeenCalled();
});
