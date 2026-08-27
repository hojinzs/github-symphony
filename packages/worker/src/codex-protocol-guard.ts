export const MAX_CODEX_PROTOCOL_LINE_BYTES = 10 * 1024 * 1024;

export function createCodexProtocolExitError(
  code: number | null,
  signal: NodeJS.Signals | null
): Error {
  return new Error(
    `port_exit: codex app-server exited with ${signal ?? code ?? "unknown"}`
  );
}

export function createCodexProtocolProcessError(cause: Error): Error {
  return new Error(
    (cause as NodeJS.ErrnoException).code === "ENOENT"
      ? `codex_not_found: ${cause.message}`
      : `port_exit: ${cause.message}`
  );
}

export function createCodexProtocolFrameError(): Error {
  return new Error(
    `response_error: codex stdout line exceeded ${MAX_CODEX_PROTOCOL_LINE_BYTES} bytes`
  );
}

export function createCodexProtocolFailureGate({
  onFailure,
  terminate,
}: {
  onFailure: (error: Error) => void;
  terminate: () => void;
}): {
  fail: (error: Error) => void;
  failure: () => Error | null;
} {
  let protocolFailure: Error | null = null;

  return {
    fail(error: Error): void {
      if (protocolFailure) {
        return;
      }
      protocolFailure = error;
      onFailure(error);
      try {
        terminate();
      } catch {
        // A terminal failure can race with normal child-process cleanup.
      }
    },
    failure(): Error | null {
      return protocolFailure;
    },
  };
}

export function createCodexProtocolLineFramer({
  onMessage,
  onNonJson,
  onFailure,
}: {
  onMessage: (message: Record<string, unknown>) => void;
  onNonJson: (line: string) => void;
  onFailure: (error: Error) => void;
}): (chunk: Buffer) => void {
  let lineBuffer = "";

  return (chunk: Buffer): void => {
    lineBuffer += chunk.toString("utf8");
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";

    for (const line of lines) {
      if (Buffer.byteLength(line, "utf8") > MAX_CODEX_PROTOCOL_LINE_BYTES) {
        onFailure(createCodexProtocolFrameError());
        return;
      }
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        onMessage(JSON.parse(trimmed) as Record<string, unknown>);
      } catch {
        onNonJson(trimmed);
      }
    }

    if (Buffer.byteLength(lineBuffer, "utf8") > MAX_CODEX_PROTOCOL_LINE_BYTES) {
      onFailure(createCodexProtocolFrameError());
    }
  };
}
