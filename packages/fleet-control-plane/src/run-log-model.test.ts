import { describe, expect, it, vi } from "vitest";
import {
  LIMITS,
  LOG_STREAMS,
  type ReadResult,
} from "@gh-symphony/management-protocol";
import { RunLogModel } from "./run-log-model.js";

const identity = {
  environmentId: "environment",
  projectId: "project",
  runId: "known-run",
  stream: LOG_STREAMS[0],
};
const completedAt = new Date().toISOString();
function chunk(text = "retained", reset = false): ReadResult {
  return {
    readId: "b148c7e9-1af0-46cf-a79a-15e954966273",
    state: "completed",
    completedAt,
    payload: {
      kind: "log-chunk",
      runId: identity.runId,
      stream: identity.stream,
      text,
      cursor: "generation:offset",
      reset,
      eof: false,
    },
  };
}
function load(model: RunLogModel, result = chunk()) {
  const request = model.begin()!;
  model.receive(request.revision, result);
  return request;
}

describe("C18 bounded log state against independent protocol results", () => {
  it("validates selection, fences results and bounds retained Unicode text", () => {
    expect(() => new RunLogModel(identity, [])).toThrow("Unknown run");
    expect(
      () =>
        new RunLogModel({ ...identity, stream: "../../secret" as never }, [
          identity.runId,
        ])
    ).toThrow();
    const model = new RunLogModel(identity, [identity.runId]);
    const request = model.begin()!;
    expect(request.selection).toEqual({
      kind: "log-chunk",
      runId: identity.runId,
      stream: identity.stream,
      maxBytes: 262144,
    });
    expect(model.phase).toBe("loading");
    expect(model.begin()).toBeUndefined();
    const foreign = chunk();
    if (foreign.state === "completed" && foreign.payload.kind === "log-chunk")
      foreign.payload.runId = "foreign";
    expect(() => model.receive(request.revision, foreign)).toThrow(
      "Mismatched"
    );
    model.receive(request.revision, chunk("🙂".repeat(65536)));
    load(model, chunk("tail"));
    expect(new TextEncoder().encode(model.text).length).toBe(
      LIMITS.logChunkBytes
    );
    expect(model.text.startsWith("🙂")).toBe(true);
    expect(model.text.endsWith("tail")).toBe(true);
    expect(model.cursor).toBe("generation:offset");
    expect(model.fetchedAt).toBe(completedAt);
    const next = model.begin()!;
    expect(next.selection).toHaveProperty("cursor", "generation:offset");
    expect(() =>
      model.receive(next.revision, chunk("x".repeat(262145)))
    ).toThrow();
  });

  it("trims full chunks with one encoding and preserves mixed UTF-8 boundaries", () => {
    const model = new RunLogModel(identity, [identity.runId]);
    load(model, chunk("x".repeat(LIMITS.logChunkBytes)));
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    try {
      load(model, chunk("é🙂"));
      // The protocol validator encodes the wire chunk once as well.
      expect(encode).toHaveBeenCalledTimes(2);
      expect(model.text).toBe("x".repeat(LIMITS.logChunkBytes - 6) + "é🙂");
    } finally {
      encode.mockRestore();
    }
    model.text = "";
    load(model, chunk("\uFEFFlog"));
    expect(model.text).toBe("\uFEFFlog");
    // Each overflow cuts inside a 2-, 3- or 4-byte code point.
    for (const point of ["é", "€", "🙂"]) {
      const width = new TextEncoder().encode(point).length;
      model.text = point + "x".repeat(LIMITS.logChunkBytes - width);
      load(model, chunk("!"));
      expect(model.text).toBe("x".repeat(LIMITS.logChunkBytes - width) + "!");
    }
  });

  it("requires explicit rotation reset even across disconnect and reconnect", () => {
    const model = new RunLogModel(identity, [identity.runId]);
    load(model);
    model.follow();
    load(model, chunk("must not append", true));
    expect(model.phase).toBe("reset-required");
    expect(model.text).toBe("retained");
    expect(model.following).toBe(false);
    expect(model.begin()).toBeUndefined();
    model.disconnect();
    model.reset();
    model.reconnect();
    expect(model.phase).toBe("reset-required");
    model.reset();
    expect(model.text).toBe("");
    expect(model.fetchedAt).toBeUndefined();
    expect(model.begin()!.selection).not.toHaveProperty("cursor");
  });

  it("preserves historical content, pauses follow and rejects late responses", () => {
    const model = new RunLogModel(identity, [identity.runId]);
    load(model);
    model.follow();
    expect(model.following).toBe(true);
    model.pause();
    expect(model.following).toBe(false);
    model.follow();
    const old = model.begin()!;
    model.disconnect();
    model.receive(old.revision, chunk("late"));
    expect(model.phase).toBe("offline");
    expect(model.text).toBe("retained");
    expect(model.fetchedAt).toBe(completedAt);
    expect(model.historical).toBe(true);
    expect(model.following).toBe(false);
    expect(model.begin()).toBeUndefined();
    model.reconnect();
    expect(model.following).toBe(false);
    expect(model.historical).toBe(true);
    for (const state of ["expired", "unavailable"] as const) {
      load(model, {
        readId: "b148c7e9-1af0-46cf-a79a-15e954966273",
        state,
        diagnostic: { code: "log_unavailable", message: "Read unavailable" },
      });
      expect(model.phase).toBe(state);
      expect(model.text).toBe("retained");
    }
    const fresh = model.begin()!;
    model.follow();
    model.receive(fresh.revision, chunk("historical"), true);
    expect(model.historical).toBe(true);
    expect(model.following).toBe(false);
  });
});
