import { afterEach, describe, expect, it, vi } from "vitest";
import { setNoColor, stripAnsi } from "../ansi.js";
import { runCli } from "../index.js";
import {
  COMMAND_COLUMN_WIDTH,
  HELP_SECTIONS,
  renderHelp,
} from "./help.js";

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
  setNoColor(false);
  delete process.env.NO_COLOR;
  process.exitCode = undefined;
});

describe("help output", () => {
  it("renders the colored grouped help snapshot", () => {
    expect(renderHelp({ color: true })).toMatchSnapshot();
  });

  it("renders the non-colored grouped help snapshot", () => {
    expect(renderHelp({ color: false })).toMatchSnapshot();
  });

  it("honors the shared no-color switch", () => {
    setNoColor(true);

    const output = renderHelp({ color: true });

    expect(output).toBe(stripAnsi(output));
  });

  it("keeps command names within the fixed help column", () => {
    const longestName = Math.max(
      ...HELP_SECTIONS.flatMap((section) =>
        section.entries.map((entry) => entry.name.length)
      )
    );

    expect(longestName).toBeLessThanOrEqual(COMMAND_COLUMN_WIDTH);
  });

  it("prints byte-identical output for help and root --help", async () => {
    const helpStdout = captureWrites(process.stdout);
    try {
      await runCli(["help"]);
    } finally {
      helpStdout.restore();
    }
    setNoColor(false);
    delete process.env.NO_COLOR;
    process.exitCode = undefined;

    const rootHelpStdout = captureWrites(process.stdout);
    try {
      await runCli(["--help"]);
    } finally {
      rootHelpStdout.restore();
    }

    expect(helpStdout.output()).toBe(rootHelpStdout.output());
  });

  it("strips ANSI escapes for root --no-color help", async () => {
    const stdout = captureWrites(process.stdout);

    try {
      await runCli(["--no-color", "--help"]);
    } finally {
      stdout.restore();
    }

    const output = stdout.output();
    expect(output).toBe(stripAnsi(output));
    expect(output).toBe(renderHelp({ color: false }));
  });
});
