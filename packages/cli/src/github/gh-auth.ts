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

export type GitHubAuthAttemptFailure = {
  source: GitHubAuthSource;
  code: GitHubAuthError["code"];
  message: string;
};

export type GhAuthRemediationResult = {
  mode: "login" | "refresh";
  status: "applied" | "manual";
  command: string;
  summary: string;
};

export class GitHubAuthError extends Error {
  constructor(
    public readonly code:
      | "not_installed"
      | "not_authenticated"
      | "missing_scopes"
      | "token_failed"
      | "invalid_token"
      | "all_sources_failed",
    message: string,
    public readonly details: {
      missingScopes?: string[];
      currentScopes?: string[];
      source?: GitHubAuthSource;
      attempts?: GitHubAuthAttemptFailure[];
    } = {}
  ) {
    super(message);
    this.name = "GitHubAuthError";
  }
}

// Backward-compatible export for existing CLI consumers.
export { GitHubAuthError as GhAuthError };

export type GhAuthRemediation = {
  title: string;
  message: string;
  command?: string;
  hint: string;
};

export type ResolvedGitHubAuth = {
  source: GitHubAuthSource;
  token: string;
  login: string;
  scopes: string[];
  configuredSources?: GitHubAuthSource[];
};

function ghTokenReadErrorMessage(): string {
  return "Failed to read a GitHub token from gh CLI. Run 'gh auth status' and try again.";
}

function missingGhScopesMessage(missing: string[]): string {
  return `Run 'gh auth refresh --scopes ${REQUIRED_GH_SCOPES.join(",")}'. Missing scopes: ${missing.join(", ")}`;
}

function parseMissingScopes(message: string): string[] {
  const matched = message.match(/Missing scopes:\s*([^.\n]+)/i);
  if (!matched) {
    return [];
  }
  return matched[1]
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

export function formatGhAuthRemediation(
  error: GitHubAuthError,
  opts?: { retryCommand?: string }
): GhAuthRemediation {
  const retryCommand = opts?.retryCommand ?? "gh-symphony repo start";

  switch (error.code) {
    case "not_installed":
      return {
        title: "GitHub authentication is not available",
        message: error.message,
        hint: "Install gh CLI from https://cli.github.com or set GITHUB_GRAPHQL_TOKEN.",
      };
    case "not_authenticated": {
      const command = `gh auth login --scopes ${REQUIRED_GH_SCOPES.join(",")}`;
      return {
        title: "GitHub authentication is required",
        message: error.message,
        command,
        hint: `Run '${command}', then re-run '${retryCommand}'.`,
      };
    }
    case "missing_scopes": {
      if (error.details.source === "env") {
        return {
          title: "GitHub token is missing required scopes",
          message: error.message,
          hint: `Update GITHUB_GRAPHQL_TOKEN with a token that has ${REQUIRED_GH_SCOPES.join(",")} scopes, or unset it to use gh CLI auth, then re-run '${retryCommand}'.`,
        };
      }
      const currentSet = new Set(
        (error.details.currentScopes ?? []).map((scope) => scope.toLowerCase())
      );
      const inferredMissing =
        currentSet.size > 0
          ? REQUIRED_GH_SCOPES.filter((scope) => !currentSet.has(scope))
          : [];
      const missing = error.details.missingScopes?.length
        ? error.details.missingScopes
        : inferredMissing.length > 0
          ? inferredMissing
          : parseMissingScopes(error.message);
      const scopeArg =
        missing.length > 0 ? missing.join(",") : REQUIRED_GH_SCOPES.join(",");
      const command = `gh auth refresh --scopes ${scopeArg}`;
      return {
        title: "GitHub token is missing required scopes",
        message: error.message,
        command,
        hint: `Run '${command}', then re-run '${retryCommand}'.`,
      };
    }
    case "invalid_token":
    case "token_failed": {
      if (error.details.source === "env") {
        return {
          title: "GitHub token validation failed",
          message: error.message,
          hint: `Update or unset GITHUB_GRAPHQL_TOKEN, then re-run '${retryCommand}'.`,
        };
      }
      const command = `gh auth login --scopes ${REQUIRED_GH_SCOPES.join(",")}`;
      return {
        title: "GitHub token validation failed",
        message: error.message,
        command,
        hint: `Run '${command}' to re-authenticate, then re-run '${retryCommand}'.`,
      };
    }
    case "all_sources_failed":
      return {
        title: "GitHub authentication sources failed",
        message: error.message,
        hint: `Update or unset GITHUB_GRAPHQL_TOKEN and verify 'gh auth status', then re-run '${retryCommand}'.`,
      };
    default: {
      const exhaustive: never = error.code;
      throw new Error(`Unhandled GitHubAuthError code: ${exhaustive}`);
    }
  }
}

function classifyTokenValidationError(
  error: unknown,
  source: GitHubAuthSource
): GitHubAuthError {
  if (error instanceof GitHubAuthError) {
    return error;
  }

  if (error instanceof GitHubApiError) {
    if (error.status === 401) {
      return new GitHubAuthError(
        source === "env" ? "invalid_token" : "token_failed",
        source === "env"
          ? "GITHUB_GRAPHQL_TOKEN is invalid or expired."
          : ghTokenReadErrorMessage(),
        { source }
      );
    }

    const prefix =
      source === "env"
        ? "GITHUB_GRAPHQL_TOKEN could not be validated"
        : "gh CLI token could not be validated";
    return new GitHubAuthError("token_failed", `${prefix}: ${error.message}`, {
      source,
    });
  }

  if (error instanceof Error) {
    const prefix =
      source === "env"
        ? "GITHUB_GRAPHQL_TOKEN could not be validated"
        : "gh CLI token could not be validated";
    return new GitHubAuthError("token_failed", `${prefix}: ${error.message}`, {
      source,
    });
  }

  return new GitHubAuthError(
    "token_failed",
    source === "env"
      ? "GITHUB_GRAPHQL_TOKEN could not be validated."
      : "gh CLI token could not be validated.",
    { source }
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

function ghAuthHostArgs(hostname?: string): string[] {
  const trimmed = hostname?.trim();
  return trimmed ? ["--hostname", trimmed] : [];
}

export function checkGhAuthenticated(opts?: {
  spawnImpl?: SpawnImpl;
  hostname?: string;
}): {
  authenticated: boolean;
  login?: string;
} {
  const spawnImpl = opts?.spawnImpl ?? spawnSync;
  const result = spawnImpl(
    "gh",
    ["auth", "status", ...ghAuthHostArgs(opts?.hostname)],
    {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }
  );

  if ((result.status ?? 1) !== 0) {
    return { authenticated: false };
  }

  const login = parseLogin((result.stdout ?? "").toString());
  return { authenticated: true, login };
}

function hasConfiguredGhAuth(opts?: {
  execImpl?: ExecImpl;
  spawnImpl?: SpawnImpl;
  hostname?: string;
}): boolean {
  try {
    return (
      checkGhInstalled({ execImpl: opts?.execImpl }) &&
      checkGhAuthenticated({
        spawnImpl: opts?.spawnImpl,
        hostname: opts?.hostname,
      }).authenticated
    );
  } catch {
    return false;
  }
}

export function checkGhScopes(opts?: {
  spawnImpl?: SpawnImpl;
  hostname?: string;
}): {
  valid: boolean;
  missing: string[];
  scopes: string[];
} {
  const spawnImpl = opts?.spawnImpl ?? spawnSync;
  const result = spawnImpl(
    "gh",
    ["auth", "status", ...ghAuthHostArgs(opts?.hostname)],
    {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }
  );

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
  hostname?: string;
}): string {
  const envToken = opts?.allowEnv === false ? null : getEnvGitHubToken();
  if (envToken) {
    return envToken;
  }

  return getGhTokenWithSource({
    execImpl: opts?.execImpl,
    envToken: undefined,
    hostname: opts?.hostname,
  }).token;
}

export function getGhTokenWithSource(opts?: {
  execImpl?: ExecImpl;
  envToken?: string | undefined;
  hostname?: string;
}): {
  token: string;
  source: GitHubAuthSource;
} {
  const hasExplicitEnvToken =
    opts !== undefined &&
    Object.prototype.hasOwnProperty.call(opts, "envToken");
  const envToken = hasExplicitEnvToken
    ? (opts.envToken?.trim() ?? null)
    : getEnvGitHubToken();
  if (envToken) {
    return { token: envToken, source: "env" };
  }

  const execImpl = opts?.execImpl ?? execFileSync;

  try {
    const token = execImpl(
      "gh",
      ["auth", "token", ...ghAuthHostArgs(opts?.hostname)],
      {
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      }
    )
      .toString()
      .trim();

    if (!token) {
      throw new GitHubAuthError("token_failed", ghTokenReadErrorMessage(), {
        source: "gh",
      });
    }

    return { token, source: "gh" };
  } catch (error) {
    if (error instanceof GitHubAuthError) {
      throw error;
    }

    throw new GitHubAuthError("token_failed", ghTokenReadErrorMessage(), {
      source: "gh",
    });
  }
}

export async function validateGitHubToken(
  token: string,
  source: GitHubAuthSource,
  opts?: {
    apiUrl?: string;
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
    const client = createClientImpl(token, {
      apiUrl: opts?.apiUrl,
    }) as GitHubClient;
    viewer = await validateTokenImpl(client);
  } catch (error) {
    throw classifyTokenValidationError(error, source);
  }

  const scopeCheck = checkRequiredScopesImpl(viewer.scopes);
  if (!scopeCheck.valid) {
    if (source === "env") {
      throw new GitHubAuthError(
        "missing_scopes",
        `GITHUB_GRAPHQL_TOKEN is missing required scopes: ${scopeCheck.missing.join(", ")}`,
        {
          missingScopes: [...scopeCheck.missing],
          currentScopes: viewer.scopes,
          source,
        }
      );
    }

    throw new GitHubAuthError(
      "missing_scopes",
      missingGhScopesMessage(scopeCheck.missing),
      {
        missingScopes: [...scopeCheck.missing],
        currentScopes: viewer.scopes,
        source,
      }
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
  apiUrl?: string;
  hostname?: string;
  createClientImpl?: typeof createClient;
  validateTokenImpl?: typeof validateToken;
  checkRequiredScopesImpl?: typeof checkRequiredScopes;
}): Promise<ResolvedGitHubAuth> {
  const envToken = getEnvGitHubToken();
  let envError: GitHubAuthError | null = null;

  if (envToken) {
    try {
      const resolved = await validateGitHubToken(envToken, "env", opts);
      return hasConfiguredGhAuth(opts)
        ? { ...resolved, configuredSources: ["env", "gh"] }
        : resolved;
    } catch (error) {
      if (error instanceof GitHubAuthError) {
        envError = error;
      } else {
        throw error;
      }
    }
  }

  try {
    const auth = ensureGhAuth(opts);
    const resolved = await validateGitHubToken(auth.token, "gh", opts);
    return envToken
      ? { ...resolved, configuredSources: ["env", "gh"] }
      : resolved;
  } catch (error) {
    if (envError && error instanceof GitHubAuthError) {
      const attempts: GitHubAuthAttemptFailure[] = [envError, error].map(
        (failure) => ({
          source: failure.details.source ?? "gh",
          code: failure.code,
          message: failure.message,
        })
      );
      throw new GitHubAuthError(
        "all_sources_failed",
        [
          "All configured GitHub authentication sources failed:",
          ...attempts.map(
            (attempt) =>
              `- ${attempt.source === "env" ? "GITHUB_GRAPHQL_TOKEN" : "gh CLI"}: ${attempt.message}`
          ),
        ].join("\n"),
        { attempts }
      );
    }
    throw error;
  }
}

export function ensureGhAuth(opts?: {
  execImpl?: ExecImpl;
  spawnImpl?: SpawnImpl;
  hostname?: string;
}): {
  login: string;
  token: string;
  source: "gh";
} {
  const execImpl = opts?.execImpl ?? execFileSync;
  const spawnImpl = opts?.spawnImpl ?? spawnSync;

  if (!checkGhInstalled({ execImpl })) {
    throw new GitHubAuthError(
      "not_installed",
      "gh CLI is not installed. Install it from https://cli.github.com or set GITHUB_GRAPHQL_TOKEN.",
      { source: "gh" }
    );
  }

  const auth = checkGhAuthenticated({ spawnImpl, hostname: opts?.hostname });
  if (!auth.authenticated) {
    throw new GitHubAuthError(
      "not_authenticated",
      "Run 'gh auth login --scopes repo,read:org,project' or set GITHUB_GRAPHQL_TOKEN.",
      { source: "gh" }
    );
  }

  const scopeCheck = checkGhScopes({ spawnImpl, hostname: opts?.hostname });
  if (!scopeCheck.valid) {
    throw new GitHubAuthError(
      "missing_scopes",
      missingGhScopesMessage(scopeCheck.missing),
      {
        missingScopes: [...scopeCheck.missing],
        currentScopes: scopeCheck.scopes,
        source: "gh",
      }
    );
  }

  const { token } = getGhTokenWithSource({
    execImpl,
    envToken: undefined,
    hostname: opts?.hostname,
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
    /Logged in to \S+ account\s+\*?\*?([A-Za-z0-9_-]+)\*?\*?/i
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
