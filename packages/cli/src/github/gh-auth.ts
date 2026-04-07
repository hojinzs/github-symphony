import { execFileSync, spawnSync } from "node:child_process";
import {
  checkRequiredScopes,
  createClient,
  type GitHubClient,
  validateToken,
} from "./client.js";

type ExecImpl = typeof execFileSync;
type SpawnImpl = typeof spawnSync;

type ExecError = Error & {
  code?: string;
  status?: number;
  stderr?: Buffer | string;
  stdout?: Buffer | string;
};

export const REQUIRED_GH_SCOPES = ["repo", "read:org", "project"] as const;

export class GhAuthError extends Error {
  constructor(
    public readonly code:
      | "not_installed"
      | "not_authenticated"
      | "missing_scopes"
      | "token_failed"
      | "invalid_token",
    message: string
  ) {
    super(message);
    this.name = "GhAuthError";
  }
}

export type GitHubAuthSource = "env" | "gh";

export type ResolvedGitHubAuth = {
  source: GitHubAuthSource;
  token: string;
  login: string;
  scopes: string[];
};

export function getEnvGitHubToken(): string | null {
  const token = process.env.GITHUB_GRAPHQL_TOKEN?.trim();
  return token ? token : null;
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

export function getGhToken(opts?: {
  execImpl?: ExecImpl;
  allowEnv?: boolean;
}): string {
  const envToken = opts?.allowEnv === false ? null : getEnvGitHubToken();
  if (envToken) {
    return envToken;
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

    return token;
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

export async function validateGitHubToken(
  token: string,
  source: GitHubAuthSource,
  opts?: {
    createClientImpl?: typeof createClient;
    validateTokenImpl?: typeof validateToken;
    checkRequiredScopesImpl?: typeof checkRequiredScopes;
  }
): Promise<ResolvedGitHubAuth> {
  const createClientImpl = opts?.createClientImpl ?? createClient;
  const validateTokenImpl = opts?.validateTokenImpl ?? validateToken;
  const checkRequiredScopesImpl =
    opts?.checkRequiredScopesImpl ?? checkRequiredScopes;

  let viewer: Awaited<ReturnType<typeof validateToken>>;
  try {
    const client = createClientImpl(token) as GitHubClient;
    viewer = await validateTokenImpl(client);
  } catch {
    if (source === "env") {
      throw new GhAuthError(
        "invalid_token",
        "GITHUB_GRAPHQL_TOKEN is invalid or expired."
      );
    }

    throw new GhAuthError(
      "token_failed",
      "gh auth token 실패. gh auth status 를 확인하세요."
    );
  }

  const scopeCheck = checkRequiredScopesImpl(viewer.scopes);
  if (!scopeCheck.valid) {
    if (source === "env") {
      throw new GhAuthError(
        "missing_scopes",
        `GITHUB_GRAPHQL_TOKEN is missing required scopes: ${scopeCheck.missing.join(", ")}`
      );
    }

    throw new GhAuthError(
      "missing_scopes",
      `gh auth refresh --scopes repo,read:org,project 를 실행하세요. (missing: ${scopeCheck.missing.join(", ")})`
    );
  }

  return {
    source,
    token,
    login: viewer.login,
    scopes: viewer.scopes,
  };
}

export async function resolveGitHubAuth(opts?: {
  execImpl?: ExecImpl;
  spawnImpl?: SpawnImpl;
  createClientImpl?: typeof createClient;
  validateTokenImpl?: typeof validateToken;
  checkRequiredScopesImpl?: typeof checkRequiredScopes;
}): Promise<ResolvedGitHubAuth> {
  const envToken = getEnvGitHubToken();
  let envError: GhAuthError | null = null;

  if (envToken) {
    try {
      return await validateGitHubToken(envToken, "env", opts);
    } catch (error) {
      if (error instanceof GhAuthError) {
        envError = error;
      } else {
        throw error;
      }
    }
  }

  try {
    const auth = ensureGhAuth(opts);
    return await validateGitHubToken(auth.token, "gh", opts);
  } catch (error) {
    if (envError && error instanceof GhAuthError) {
      throw envError;
    }
    throw error;
  }
}

export function ensureGhAuth(opts?: {
  execImpl?: ExecImpl;
  spawnImpl?: SpawnImpl;
}): {
  login: string;
  token: string;
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

  const token = getGhToken({ execImpl, allowEnv: false });
  return { login: auth.login ?? "unknown", token };
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
