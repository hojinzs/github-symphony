import { afterEach, describe, expect, it, vi } from "vitest";
import { createRemovedCommandHandler } from "./removed-command.js";

function captureWrites(stream: NodeJS.WriteStream): {
  output: () => string;
  restore: () => void;
} {
  let buffer = "";
  const spy = vi.spyOn(stream, "write").mockImplementation(((
    chunk: string | Uint8Array
  ) => {
    buffer +=
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof stream.write);

  return {
    output: () => buffer,
    restore: () => spy.mockRestore(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("createRemovedCommandHandler", () => {
  it("writes the migration message to stderr and exits 2", async () => {
    const stderr = captureWrites(process.stderr);
    const handler = createRemovedCommandHandler(
      "Use 'gh-symphony repo status'."
    );

    try {
      await handler([], {
        configDir: "/tmp/gh-symphony-test",
        verbose: false,
        json: true,
        noColor: true,
      });
    } finally {
      stderr.restore();
    }

    expect(stderr.output()).toBe("Use 'gh-symphony repo status'.\n");
    expect(process.exitCode).toBe(2);
  });
});
