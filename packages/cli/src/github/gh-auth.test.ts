import type { execFileSync, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GhAuthError,
  checkGhAuthenticated,
  checkGhInstalled,
  checkGhScopes,
  ensureGhAuth,
  getGhToken,
} from "./gh-auth.js";

type ExecMock = ReturnType<typeof vi.fn> & typeof execFileSync;
type SpawnMock = ReturnType<typeof vi.fn> & typeof spawnSync;

function buildExitError(status: number, stderr = "", stdout = ""): Error {
  const error = new Error("exec failed") as Error & {
    status: number;
    stderr: string;
    stdout: string;
  };
  error.status = status;
  error.stderr = stderr;
  error.stdout = stdout;
  return error;
}

const originalGraphQlToken = process.env.GITHUB_GRAPHQL_TOKEN;

function buildSpawnResult(status: number, stderr = "", stdout = "") {
  return {
    status,
    stdout,
    stderr,
    pid: 1,
    signal: null,
    output: [null, stdout, stderr],
  };
}

afterEach(() => {
  if (originalGraphQlToken === undefined) {
    delete process.env.GITHUB_GRAPHQL_TOKEN;
  } else {
    process.env.GITHUB_GRAPHQL_TOKEN = originalGraphQlToken;
  }
});

describe("checkGhInstalled", () => {
  it("returns false when gh is not installed (ENOENT)", () => {
    const execImpl = vi.fn(() => {
      const error = buildExitError(1) as Error & { code: string };
      error.code = "ENOENT";
      throw error;
    }) as ExecMock;

    expect(checkGhInstalled({ execImpl })).toBe(false);
  });
});

describe("checkGhAuthenticated", () => {
  it("returns authenticated login from stderr output", () => {
    const spawnImpl = vi.fn(() =>
      buildSpawnResult(
        0,
        [
          "github.com",
          "  ✓ Logged in to github.com account testuser (/home/test/.config/gh/hosts.yml)",
        ].join("\n")
      )
    ) as SpawnMock;

    expect(checkGhAuthenticated({ spawnImpl })).toEqual({
      authenticated: true,
      login: "testuser",
    });
  });

  it("returns unauthenticated when gh auth status exits 1", () => {
    const spawnImpl = vi.fn(() =>
      buildSpawnResult(1, "You are not logged into any GitHub hosts.")
    ) as SpawnMock;

    expect(checkGhAuthenticated({ spawnImpl })).toEqual({
      authenticated: false,
    });
  });
});

describe("checkGhScopes", () => {
  it("returns missing scope when project scope is absent", () => {
    const spawnImpl = vi.fn(() =>
      buildSpawnResult(
        0,
        ["github.com", "  - Token scopes: 'repo', 'read:org'"].join("\n")
      )
    ) as SpawnMock;

    expect(checkGhScopes({ spawnImpl })).toEqual({
      valid: false,
      missing: ["project"],
      scopes: ["repo", "read:org"],
    });
  });
});

describe("getGhToken", () => {
  it("returns process env token before subprocess lookup", () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "env-token";
    const execImpl = vi.fn(() => "should-not-be-used") as ExecMock;

    expect(getGhToken({ execImpl })).toBe("env-token");
    expect(execImpl).not.toHaveBeenCalled();
  });
});

describe("ensureGhAuth", () => {
  it("returns login and token on success", () => {
    delete process.env.GITHUB_GRAPHQL_TOKEN;

    const execImpl = vi.fn((command: string, args?: string[]) => {
      if (command !== "gh") {
        throw new Error("unexpected command");
      }

      const argKey = (args ?? []).join(" ");
      if (argKey === "--version") {
        return "gh version 2.0.0";
      }
      if (argKey === "auth token") {
        return "ghp_test123\n";
      }

      throw new Error(`unexpected args: ${argKey}`);
    }) as ExecMock;

    const spawnImpl = vi.fn(() =>
      buildSpawnResult(
        0,
        [
          "github.com",
          "  ✓ Logged in to github.com account testuser (/home/test/.config/gh/hosts.yml)",
          "  - Token scopes: 'repo', 'read:org', 'project'",
        ].join("\n")
      )
    ) as SpawnMock;

    expect(ensureGhAuth({ execImpl, spawnImpl })).toEqual({
      login: "testuser",
      token: "ghp_test123",
    });
  });

  it("throws not_installed when gh is missing", () => {
    const execImpl = vi.fn((command: string, args?: string[]) => {
      if (command === "gh" && (args ?? []).join(" ") === "--version") {
        const error = buildExitError(1) as Error & { code: string };
        error.code = "ENOENT";
        throw error;
      }
      throw new Error("unexpected command");
    }) as ExecMock;

    expect(() => ensureGhAuth({ execImpl })).toThrowError(GhAuthError);
    expect(() => ensureGhAuth({ execImpl })).toThrowError(
      "gh CLI가 설치되어 있지 않습니다. https://cli.github.com 에서 설치하세요."
    );
    expect(() => ensureGhAuth({ execImpl })).toThrowError(
      expect.objectContaining({ code: "not_installed" })
    );
  });

  it("throws not_authenticated when gh auth status fails", () => {
    const execImpl = vi.fn((command: string, args?: string[]) => {
      if (command !== "gh") {
        throw new Error("unexpected command");
      }
      const argKey = (args ?? []).join(" ");
      if (argKey === "--version") {
        return "gh version 2.0.0";
      }
      throw new Error(`unexpected args: ${argKey}`);
    }) as ExecMock;

    const spawnImpl = vi.fn(() =>
      buildSpawnResult(1, "You are not logged into any GitHub hosts.")
    ) as SpawnMock;

    expect(() => ensureGhAuth({ execImpl, spawnImpl })).toThrowError(
      expect.objectContaining({ code: "not_authenticated" })
    );
  });

  it("throws missing_scopes when required scopes are missing", () => {
    const execImpl = vi.fn((command: string, args?: string[]) => {
      if (command !== "gh") {
        throw new Error("unexpected command");
      }
      const argKey = (args ?? []).join(" ");
      if (argKey === "--version") {
        return "gh version 2.0.0";
      }
      throw new Error(`unexpected args: ${argKey}`);
    }) as ExecMock;

    const spawnImpl = vi.fn(() =>
      buildSpawnResult(
        0,
        [
          "github.com",
          "  ✓ Logged in to github.com account testuser (/home/test/.config/gh/hosts.yml)",
          "  - Token scopes: 'repo', 'read:org'",
        ].join("\n")
      )
    ) as SpawnMock;

    expect(() => ensureGhAuth({ execImpl, spawnImpl })).toThrowError(
      expect.objectContaining({ code: "missing_scopes" })
    );
    expect(() => ensureGhAuth({ execImpl, spawnImpl })).toThrowError(
      "gh auth refresh --scopes repo,read:org,project 를 실행하세요. (missing: project)"
    );
  });
});
