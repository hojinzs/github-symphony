import type { execFileSync, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GitHubApiError,
} from "./client.js";
import {
  GhAuthError,
  checkGhAuthenticated,
  checkGhInstalled,
  checkGhScopes,
  detectGitHubAuthSource,
  ensureGhAuth,
  getEnvGitHubToken,
  getGhToken,
  getGhTokenWithSource,
  resolveGitHubAuth,
  validateGitHubToken,
  runGhAuthLogin,
  runGhAuthRefresh,
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
  it("returns authenticated login from stdout output", () => {
    const spawnImpl = vi.fn(() =>
      buildSpawnResult(
        0,
        "",
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
        "",
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

describe("detectGitHubAuthSource", () => {
  it("returns env when GITHUB_GRAPHQL_TOKEN is present", () => {
    expect(detectGitHubAuthSource("env-token")).toBe("env");
  });

  it("returns gh when GITHUB_GRAPHQL_TOKEN is absent", () => {
    expect(detectGitHubAuthSource("")).toBe("gh");
  });
});

describe("getGhTokenWithSource", () => {
  it("returns env token metadata before subprocess lookup", () => {
    const execImpl = vi.fn(() => "should-not-be-used") as ExecMock;

    expect(
      getGhTokenWithSource({ execImpl, envToken: "env-token" })
    ).toEqual({
      token: "env-token",
      source: "env",
    });
    expect(execImpl).not.toHaveBeenCalled();
  });

  it("allows callers to bypass env-token precedence explicitly", () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "env-token";
    const execImpl = vi.fn(() => "ghp_test123\n") as ExecMock;

    expect(
      getGhTokenWithSource({ execImpl, envToken: undefined })
    ).toEqual({
      token: "ghp_test123",
      source: "gh",
    });
    expect(execImpl).toHaveBeenCalledWith(
      "gh",
      ["auth", "token"],
      expect.objectContaining({
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      })
    );
  });
});

describe("getEnvGitHubToken", () => {
  it("returns a trimmed env token when configured", () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "  env-token  ";

    expect(getEnvGitHubToken()).toBe("env-token");
  });
});

describe("validateGitHubToken", () => {
  it("returns viewer info for a valid env token", async () => {
    const result = await validateGitHubToken("env-token", "env", {
      createClientImpl: vi.fn((token: string) => ({ token })) as never,
      validateTokenImpl: vi.fn(async () => ({
        login: "env-user",
        name: "Env User",
        scopes: ["repo", "read:org", "project"],
      })) as never,
    });

    expect(result).toEqual({
      source: "env",
      token: "env-token",
      login: "env-user",
      scopes: ["repo", "read:org", "project"],
    });
  });

  it("throws missing_scopes for an env token without required scopes", async () => {
    await expect(
      validateGitHubToken("env-token", "env", {
        createClientImpl: vi.fn((token: string) => ({ token })) as never,
        validateTokenImpl: vi.fn(async () => ({
          login: "env-user",
          name: "Env User",
          scopes: ["repo", "read:org"],
        })) as never,
      })
    ).rejects.toThrowError(
      expect.objectContaining({ code: "missing_scopes" })
    );
  });

  it("preserves non-auth GitHub API failures for env-token validation", async () => {
    await expect(
      validateGitHubToken("env-token", "env", {
        createClientImpl: vi.fn((token: string) => ({ token })) as never,
        validateTokenImpl: vi.fn(async () => {
          throw new GitHubApiError("GitHub API error: 502 Bad Gateway", 502);
        }) as never,
      })
    ).rejects.toThrowError(
      expect.objectContaining({
        code: "token_failed",
        message:
          "GITHUB_GRAPHQL_TOKEN could not be validated: GitHub API error: 502 Bad Gateway",
      })
    );
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
        "",
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
      source: "gh",
    });
  });

  it("does not relabel GITHUB_GRAPHQL_TOKEN as gh auth", () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "env-token";

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
        "",
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
      source: "gh",
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
      "gh CLI is not installed. Install it from https://cli.github.com or set GITHUB_GRAPHQL_TOKEN."
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
        "",
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
      "Run 'gh auth refresh --scopes repo,read:org,project'. Missing scopes: project"
    );
  });
});

describe("resolveGitHubAuth", () => {
  it("prefers a valid env token even when gh is not installed", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "env-token";

    const execImpl = vi.fn((command: string, args?: string[]) => {
      if (command === "gh" && (args ?? []).join(" ") === "--version") {
        const error = buildExitError(1) as Error & { code: string };
        error.code = "ENOENT";
        throw error;
      }
      throw new Error("unexpected command");
    }) as ExecMock;

    await expect(
      resolveGitHubAuth({
        execImpl,
        createClientImpl: vi.fn((token: string) => ({ token })) as never,
        validateTokenImpl: vi.fn(async () => ({
          login: "env-user",
          name: "Env User",
          scopes: ["repo", "read:org", "project"],
        })) as never,
      })
    ).resolves.toEqual({
      source: "env",
      token: "env-token",
      login: "env-user",
      scopes: ["repo", "read:org", "project"],
    });
  });

  it("falls back to gh auth when the env token is unusable", async () => {
    process.env.GITHUB_GRAPHQL_TOKEN = "bad-env-token";

    const execImpl = vi.fn((command: string, args?: string[]) => {
      if (command !== "gh") {
        throw new Error("unexpected command");
      }

      const argKey = (args ?? []).join(" ");
      if (argKey === "--version") {
        return "gh version 2.0.0";
      }
      if (argKey === "auth token") {
        return "ghp_good_token\n";
      }

      throw new Error(`unexpected args: ${argKey}`);
    }) as ExecMock;

    const spawnImpl = vi.fn(() =>
      buildSpawnResult(
        0,
        "",
        [
          "github.com",
          "  ✓ Logged in to github.com account testuser (/home/test/.config/gh/hosts.yml)",
          "  - Token scopes: 'repo', 'read:org', 'project'",
        ].join("\n")
      )
    ) as SpawnMock;

    const validateTokenImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("invalid env token"))
      .mockResolvedValueOnce({
        login: "gh-user",
        name: "GH User",
        scopes: ["repo", "read:org", "project"],
      });

    await expect(
      resolveGitHubAuth({
        execImpl,
        spawnImpl,
        createClientImpl: vi.fn((token: string) => ({ token })) as never,
        validateTokenImpl: validateTokenImpl as never,
      })
    ).resolves.toEqual({
      source: "gh",
      token: "ghp_good_token",
      login: "gh-user",
      scopes: ["repo", "read:org", "project"],
    });
  });
});

describe("runGhAuthLogin", () => {
  it("returns manual when no interactive terminal is available", () => {
    expect(runGhAuthLogin({ interactive: false })).toEqual({
      mode: "login",
      status: "manual",
      command: "gh auth login --scopes repo,read:org,project",
      summary:
        "Interactive terminal not available. Run 'gh auth login --scopes repo,read:org,project' manually.",
    });
  });
});

describe("runGhAuthRefresh", () => {
  it("runs gh auth refresh in interactive terminals", () => {
    const spawnImpl = vi.fn(() => buildSpawnResult(0)) as SpawnMock;

    expect(
      runGhAuthRefresh({ spawnImpl, interactive: true })
    ).toMatchObject({
      mode: "refresh",
      status: "applied",
      command: "gh auth refresh --scopes repo,read:org,project",
    });
    expect(spawnImpl).toHaveBeenCalledWith(
      "gh",
      ["auth", "refresh", "--scopes", "repo,read:org,project"],
      { stdio: "inherit" }
    );
  });
});
