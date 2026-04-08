import { execFileSync, spawnSync } from "node:child_process";
import {
  checkRequiredScopes,
  createClient,
  GitHubApiError,
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
export type GitHubAuthSource = "env" | "gh";

export type GhAuthRemediationResult = {
  mode: "login" | "refresh";
  status: "applied" | "manual";
  command: string;
  summary: string;
};

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

export type ResolvedGitHubAuth = {
  source: GitHubAuthSource;
  token: string;
  login: string;
  scopes: string[];
};

function ghTokenReadErrorMessage(): string {
  return "Failed to read a GitHub token from gh CLI. Run 'gh auth status' and try again.";
}

function missingGhScopesMessage(missing: string[]): string {
  return `Run 'gh auth refresh --scopes repo,read:org,project'. Missing scopes: ${missing.join(", ")}`;
}

function classifyTokenValidationError(
  error: unknown,
  source: GitHubAuthSource
): GhAuthError {
  if (error instanceof GhAuthError) {
    return error;
  }

  if (error instanceof GitHubApiError) {
    if (error.status === 401) {
      return new GhAuthError(
        source === "env" ? "invalid_token" : "token_failed",
        source === "env"
          ? "GITHUB_GRAPHQL_TOKEN is invalid or expired."
          : ghTokenReadErrorMessage()
      );
    }

    const prefix =
      source === "env"
        ? "GITHUB_GRAPHQL_TOKEN could not be validated"
        : "gh CLI token could not be validated";
    return new GhAuthError("token_failed", `${prefix}: ${error.message}`);
  }

  if (error instanceof Error) {
    const prefix =
      source === "env"
        ? "GITHUB_GRAPHQL_TOKEN could not be validated"
        : "gh CLI token could not be validated";
    return new GhAuthError("token_failed", `${prefix}: ${error.message}`);
  }

  return new GhAuthError(
    "token_failed",
    source === "env"
      ? "GITHUB_GRAPHQL_TOKEN could not be validated."
      : "gh CLI token could not be validated."
  );
}

export function getEnvGitHubToken(): string | null {
  const token = process.env.GITHUB_GRAPHQL_TOKEN?.trim();
  return token ? token : null;
}

export function detectGitHubAuthSource(
  envToken = process.env.GITHUB_GRAPHQL_TOKEN
): GitHubAuthSource {
  return envToken?.trim() ? "env" : "gh";
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

  return getGhTokenWithSource({
    execImpl: opts?.execImpl,
    envToken: undefined,
  }).token;
}

export function getGhTokenWithSource(opts?: {
  execImpl?: ExecImpl;
  envToken?: string | undefined;
}): {
  token: string;
  source: GitHubAuthSource;
} {
  const hasExplicitEnvToken =
    opts !== undefined &&
    Object.prototype.hasOwnProperty.call(opts, "envToken");
  const envToken = hasExplicitEnvToken
    ? opts.envToken?.trim() ?? null
    : getEnvGitHubToken();
  if (envToken) {
    return { token: envToken, source: "env" };
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
      throw new GhAuthError("token_failed", ghTokenReadErrorMessage());
    }

    return { token, source: "gh" };
  } catch (error) {
    if (error instanceof GhAuthError) {
      throw error;
    }

    throw new GhAuthError("token_failed", ghTokenReadErrorMessage());
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
  } catch (error) {
    throw classifyTokenValidationError(error, source);
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
      missingGhScopesMessage(scopeCheck.missing)
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
  source: "gh";
} {
  const execImpl = opts?.execImpl ?? execFileSync;
  const spawnImpl = opts?.spawnImpl ?? spawnSync;

  if (!checkGhInstalled({ execImpl })) {
    throw new GhAuthError(
      "not_installed",
      "gh CLI is not installed. Install it from https://cli.github.com or set GITHUB_GRAPHQL_TOKEN."
    );
  }

  const auth = checkGhAuthenticated({ spawnImpl });
  if (!auth.authenticated) {
    throw new GhAuthError(
      "not_authenticated",
      "Run 'gh auth login --scopes repo,read:org,project' or set GITHUB_GRAPHQL_TOKEN."
    );
  }

  const scopeCheck = checkGhScopes({ spawnImpl });
  if (!scopeCheck.valid) {
    throw new GhAuthError(
      "missing_scopes",
      missingGhScopesMessage(scopeCheck.missing)
    );
  }

  const { token } = getGhTokenWithSource({
    execImpl,
    envToken: undefined,
  });
  return { login: auth.login ?? "unknown", token, source: "gh" };
}

function isInteractiveTerminal(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function runGhAuthCommand(
  mode: "login" | "refresh",
  opts?: { spawnImpl?: SpawnImpl; interactive?: boolean }
): GhAuthRemediationResult {
  const spawnImpl = opts?.spawnImpl ?? spawnSync;
  const command = `gh auth ${mode} --scopes ${REQUIRED_GH_SCOPES.join(",")}`;
  const interactive = opts?.interactive ?? isInteractiveTerminal();

  if (!interactive) {
    return {
      mode,
      status: "manual",
      command,
      summary: `Interactive terminal not available. Run '${command}' manually.`,
    };
  }

  const result = spawnImpl(
    "gh",
    ["auth", mode, "--scopes", REQUIRED_GH_SCOPES.join(",")],
    {
      stdio: "inherit",
    }
  );

  if ((result.status ?? 1) === 0) {
    return {
      mode,
      status: "applied",
      command,
      summary: `Executed '${command}'.`,
    };
  }

  return {
    mode,
    status: "manual",
    command,
    summary: `Failed to complete '${command}' automatically. Re-run it manually.`,
  };
}

export function runGhAuthLogin(opts?: {
  spawnImpl?: SpawnImpl;
  interactive?: boolean;
}): GhAuthRemediationResult {
  return runGhAuthCommand("login", opts);
}

export function runGhAuthRefresh(opts?: {
  spawnImpl?: SpawnImpl;
  interactive?: boolean;
}): GhAuthRemediationResult {
  return runGhAuthCommand("refresh", opts);
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
