import { describe, expect, it, vi } from "vitest";
import {
  createCodexProtocolExitError,
  createCodexProtocolFailureGate,
  createCodexProtocolLineFramer,
  createCodexProtocolProcessError,
  MAX_CODEX_PROTOCOL_LINE_BYTES,
} from "./codex-protocol-guard.js";
import { buildCodexTurnInput } from "./codex-turn-input.js";

describe("codex protocol guard", () => {
  it("fails once, terminates the child, and rejects work submitted after exit", () => {
    const onFailure = vi.fn();
    const terminate = vi.fn();
    const gate = createCodexProtocolFailureGate({ onFailure, terminate });
    const exitError = createCodexProtocolExitError(1, null);

    gate.fail(exitError);
    gate.fail(createCodexProtocolExitError(2, null));

    expect(gate.failure()).toBe(exitError);
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(exitError);
    expect(terminate).toHaveBeenCalledExactlyOnceWith();
  });

  it("maps spawn ENOENT to codex_not_found and other child failures to port_exit", () => {
    const missing = Object.assign(new Error("spawn codex ENOENT"), {
      code: "ENOENT",
    });

    expect(createCodexProtocolProcessError(missing).message).toBe(
      "codex_not_found: spawn codex ENOENT"
    );
    expect(
      createCodexProtocolProcessError(new Error("stdin EPIPE")).message
    ).toBe("port_exit: stdin EPIPE");
  });

  it("rejects a line larger than 10 MiB before unbounded buffering", () => {
    const onFailure = vi.fn();
    const frame = createCodexProtocolLineFramer({
      onMessage: vi.fn(),
      onNonJson: vi.fn(),
      onFailure,
    });

    frame(Buffer.alloc(MAX_CODEX_PROTOCOL_LINE_BYTES + 1, "x"));

    expect(onFailure).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        message: `response_error: codex stdout line exceeded ${MAX_CODEX_PROTOCOL_LINE_BYTES} bytes`,
      })
    );

    frame(Buffer.from("another oversized chunk"));
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(expect.any(Error));
  });

  it("delivers the rendered prompt only in the first turn", () => {
    const renderedPrompt = "assigned issue prompt";

    expect(
      buildCodexTurnInput({
        isFirstTurn: true,
        renderedPrompt,
        issueIdentifier: "hojinzs/github-symphony#657",
        issueTitle: "Fix worker protocol",
        continuationGuidance: "Continue the assigned issue.",
        cumulativeTurnCount: 0,
      })
    ).toBe(renderedPrompt);
    expect(
      buildCodexTurnInput({
        isFirstTurn: false,
        renderedPrompt,
        issueIdentifier: "hojinzs/github-symphony#657",
        issueTitle: "Fix worker protocol",
        continuationGuidance: "Continue the assigned issue.",
        cumulativeTurnCount: 1,
      })
    ).not.toContain(renderedPrompt);
  });
});
