import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GlobalOptions } from "../index.js";

const execFileMock = vi.fn();
const spawnMock = vi.fn();

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process"
    );
  return {
    ...actual,
    execFile: execFileMock,
    spawn: spawnMock,
  };
});

const upgradeModule = await import("./upgrade.js");

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

function baseOptions(): GlobalOptions {
  return {
    configDir: "/tmp/cli-config",
    verbose: false,
    json: false,
    noColor: false,
  };
}

function mockExecFileStdout(stdout: string): void {
  execFileMock.mockImplementationOnce(
    (
      _file: string,
      _args: string[],
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => {
      callback(null, stdout, "");
    }
  );
}

function mockSpawnClose(code: number): void {
  spawnMock.mockImplementationOnce(() => {
    const child = new EventEmitter();
    queueMicrotask(() => {
      child.emit("close", code);
    });
    return child;
  });
}

afterEach(() => {
  execFileMock.mockReset();
  spawnMock.mockReset();
  vi.restoreAllMocks();
});

describe("upgrade command", () => {
  it("prints an up-to-date message when the installed version already matches", async () => {
    const stdout = captureWrites(process.stdout);
    mockExecFileStdout('"0.0.18"\n');

    try {
      await upgradeModule.runUpgradeCommand(baseOptions(), {
        currentVersion: "0.0.18",
      });
    } finally {
      stdout.restore();
    }

    expect(execFileMock).toHaveBeenCalledWith(
      "npm",
      ["view", "@gh-symphony/cli", "dist-tags.latest", "--json"],
      expect.any(Function)
    );
    expect(spawnMock).not.toHaveBeenCalled();
    expect(stdout.output()).toContain("Already up to date (v0.0.18)");
  });

  it("detects pnpm global installs and runs pnpm add -g", async () => {
    const stdout = captureWrites(process.stdout);
    mockExecFileStdout('"0.0.19"\n');
    mockExecFileStdout("/Users/test/Library/pnpm/global\n");
    mockSpawnClose(0);

    try {
      await upgradeModule.runUpgradeCommand(baseOptions(), {
        currentVersion: "0.0.18",
      });
    } finally {
      stdout.restore();
    }

    expect(spawnMock).toHaveBeenCalledWith(
      "pnpm",
      ["add", "-g", "@gh-symphony/cli@latest"],
      expect.objectContaining({ stdio: "inherit" })
    );
    expect(stdout.output()).toContain("using pnpm");
    expect(stdout.output()).toContain("Upgrade complete (v0.0.19)");
  });

  it("uses Windows-safe executables for npm and pnpm commands", async () => {
    const stdout = captureWrites(process.stdout);
    mockExecFileStdout('"0.0.19"\n');
    mockExecFileStdout("C:\\Users\\test\\AppData\\Local\\pnpm\\global\n");
    mockSpawnClose(0);

    try {
      await upgradeModule.runUpgradeCommand(baseOptions(), {
        currentVersion: "0.0.18",
        platform: "win32",
      });
    } finally {
      stdout.restore();
    }

    expect(execFileMock).toHaveBeenNthCalledWith(
      1,
      "npm.cmd",
      ["view", "@gh-symphony/cli", "dist-tags.latest", "--json"],
      expect.any(Function)
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      "npm.cmd",
      ["prefix", "-g"],
      expect.any(Function)
    );
    expect(spawnMock).toHaveBeenCalledWith(
      "pnpm.cmd",
      ["add", "-g", "@gh-symphony/cli@latest"],
      expect.objectContaining({ stdio: "inherit" })
    );
  });

  it("falls back to npm when package manager detection fails", async () => {
    const stdout = captureWrites(process.stdout);
    mockExecFileStdout('"0.0.20"\n');
    execFileMock.mockImplementationOnce(
      (
        _file: string,
        _args: string[],
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        callback(new Error("prefix failed"), "", "");
      }
    );
    mockSpawnClose(0);

    try {
      await upgradeModule.runUpgradeCommand(baseOptions(), {
        currentVersion: "0.0.18",
      });
    } finally {
      stdout.restore();
    }

    expect(spawnMock).toHaveBeenCalledWith(
      "npm",
      ["install", "-g", "@gh-symphony/cli@latest"],
      expect.objectContaining({ stdio: "inherit" })
    );
    expect(stdout.output()).toContain("using npm");
  });

  it("keeps stdout as JSON-only output during installs", async () => {
    const stdout = captureWrites(process.stdout);
    const stderr = captureWrites(process.stderr);
    mockExecFileStdout('"0.0.20"\n');
    mockExecFileStdout("/usr/local\n");
    spawnMock.mockImplementationOnce((_command, _args, options) => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();

      queueMicrotask(() => {
        child.stdout.emit("data", "npm notice installing\n");
        child.stderr.emit("data", "npm warn deprecated\n");
        child.emit("close", 0);
      });

      expect(options).toEqual(
        expect.objectContaining({
          stdio: ["ignore", "pipe", "pipe"],
        })
      );

      return child;
    });

    try {
      await upgradeModule.runUpgradeCommand(
        {
          ...baseOptions(),
          json: true,
        },
        {
          currentVersion: "0.0.18",
        }
      );
    } finally {
      stdout.restore();
      stderr.restore();
    }

    expect(stdout.output().trim()).toBe(
      JSON.stringify({
        status: "upgraded",
        previousVersion: "0.0.18",
        latestVersion: "0.0.20",
        packageManager: "npm",
      })
    );
    expect(stderr.output()).toContain("npm notice installing");
    expect(stderr.output()).toContain("npm warn deprecated");
  });
});
