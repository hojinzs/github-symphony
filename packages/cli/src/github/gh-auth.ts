import { execFileSync, spawnSync } from "node:child_process";

type ExecImpl = typeof execFileSync;
type SpawnImpl = typeof spawnSync;

type ExecError = Error & {
  code?: string;
  status?: number;
  stderr?: Buffer | string;
  stdout?: Buffer | string;
};

export const REQUIRED_GH_SCOPES = ["repo", "read:org", "project"] as const;
export type GitHubAuthSource = "env" | "gh";

export class GhAuthError extends Error {
  constructor(
    public readonly code:
      | "not_installed"
      | "not_authenticated"
      | "missing_scopes"
      | "token_failed",
    message: string
  ) {
    super(message);
    this.name = "GhAuthError";
  }
}

export function checkGhInstalled(opts?: { execImpl?: ExecImpl }): boolean {
  const execImpl = opts?.execImpl ?? execFileSync;

  try {
    execImpl("gh", ["--version"], { stdio: "pipe" });
    return true;
  } catch (error) {
    const execError = error as ExecError;
    if (execError.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function checkGhAuthenticated(opts?: { spawnImpl?: SpawnImpl }): {
  authenticated: boolean;
  login?: string;
} {
  const spawnImpl = opts?.spawnImpl ?? spawnSync;
  const result = spawnImpl("gh", ["auth", "status"], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  if ((result.status ?? 1) !== 0) {
    return { authenticated: false };
  }

  const login = parseLogin((result.stdout ?? "").toString());
  return { authenticated: true, login };
}

export function checkGhScopes(opts?: { spawnImpl?: SpawnImpl }): {
  valid: boolean;
  missing: string[];
  scopes: string[];
} {
  const spawnImpl = opts?.spawnImpl ?? spawnSync;
  const result = spawnImpl("gh", ["auth", "status"], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  const output = (result.stdout ?? "").toString();

  const scopes = parseScopes(output);
  if (scopes.length === 0) {
    return { valid: true, missing: [], scopes: [] };
  }

  const normalized = scopes.map((scope) => scope.toLowerCase());
  const missing = REQUIRED_GH_SCOPES.filter(
    (scope) => !normalized.includes(scope)
  );
  return {
    valid: missing.length === 0,
    missing: [...missing],
    scopes,
  };
}

export function getGhToken(opts?: { execImpl?: ExecImpl }): string {
  return getGhTokenWithSource(opts).token;
}

export function detectGitHubAuthSource(
  envToken = process.env.GITHUB_GRAPHQL_TOKEN
): GitHubAuthSource {
  return envToken ? "env" : "gh";
}

export function getGhTokenWithSource(opts?: {
  execImpl?: ExecImpl;
  envToken?: string | undefined;
}): {
  token: string;
  source: GitHubAuthSource;
} {
  const envToken = opts?.envToken ?? process.env.GITHUB_GRAPHQL_TOKEN;
  if (envToken) {
    return { token: envToken, source: "env" };
  }

  if (process.env.GITHUB_GRAPHQL_TOKEN) {
    return {
      token: process.env.GITHUB_GRAPHQL_TOKEN,
      source: "env",
    };
  }

  const execImpl = opts?.execImpl ?? execFileSync;

  try {
    const token = execImpl("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    })
      .toString()
      .trim();

    if (!token) {
      throw new GhAuthError(
        "token_failed",
        "gh auth token 실패. gh auth status 를 확인하세요."
      );
    }

    return { token, source: "gh" };
  } catch (error) {
    if (error instanceof GhAuthError) {
      throw error;
    }

    throw new GhAuthError(
      "token_failed",
      "gh auth token 실패. gh auth status 를 확인하세요."
    );
  }
}

export function ensureGhAuth(opts?: {
  execImpl?: ExecImpl;
  spawnImpl?: SpawnImpl;
}): {
  login: string;
  token: string;
  source: "gh";
} {
  const execImpl = opts?.execImpl ?? execFileSync;
  const spawnImpl = opts?.spawnImpl ?? spawnSync;

  if (!checkGhInstalled({ execImpl })) {
    throw new GhAuthError(
      "not_installed",
      "gh CLI가 설치되어 있지 않습니다. https://cli.github.com 에서 설치하세요."
    );
  }

  const auth = checkGhAuthenticated({ spawnImpl });
  if (!auth.authenticated) {
    throw new GhAuthError(
      "not_authenticated",
      "gh auth login --scopes repo,read:org,project 를 실행하세요."
    );
  }

  const scopeCheck = checkGhScopes({ spawnImpl });
  if (!scopeCheck.valid) {
    throw new GhAuthError(
      "missing_scopes",
      `gh auth refresh --scopes repo,read:org,project 를 실행하세요. (missing: ${scopeCheck.missing.join(", ")})`
    );
  }

  const { token } = getGhTokenWithSource({
    execImpl,
    envToken: undefined,
  });
  return { login: auth.login ?? "unknown", token, source: "gh" };
}

function parseLogin(output: string): string | undefined {
  const matched = output.match(
    /Logged in to github\.com account\s+\*?\*?([A-Za-z0-9_-]+)\*?\*?/i
  );
  return matched?.[1];
}

function parseScopes(output: string): string[] {
  const matched = output.match(/Token scopes:\s*(.+)/i);
  if (!matched) {
    return [];
  }

  return matched[1]
    .split(",")
    .map((scope) => scope.trim().replace(/^'+|'+$/g, ""))
    .filter((scope) => scope.length > 0);
}
