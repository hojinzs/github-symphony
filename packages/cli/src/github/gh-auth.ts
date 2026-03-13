import { execFileSync } from "node:child_process";

type ExecImpl = typeof execFileSync;

type ExecError = Error & {
  code?: string;
  status?: number;
  stderr?: Buffer | string;
  stdout?: Buffer | string;
};

const REQUIRED_SCOPES = ["repo", "read:org", "project"] as const;

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

export function checkGhAuthenticated(opts?: { execImpl?: ExecImpl }): {
  authenticated: boolean;
  login?: string;
} {
  const execImpl = opts?.execImpl ?? execFileSync;

  try {
    const output = execImpl("gh", ["auth", "status"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const login = parseLogin(output.toString());
    return { authenticated: true, login };
  } catch (error) {
    const execError = error as ExecError;
    if (execError.status === 1) {
      return { authenticated: false };
    }
    throw error;
  }
}

export function checkGhScopes(opts?: { execImpl?: ExecImpl }): {
  valid: boolean;
  missing: string[];
  scopes: string[];
} {
  const execImpl = opts?.execImpl ?? execFileSync;

  const output = execImpl("gh", ["auth", "status"], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).toString();

  const scopes = parseScopes(output);
  if (scopes.length === 0) {
    return { valid: true, missing: [], scopes: [] };
  }

  const normalized = scopes.map((scope) => scope.toLowerCase());
  const missing = REQUIRED_SCOPES.filter(
    (scope) => !normalized.includes(scope)
  );
  return {
    valid: missing.length === 0,
    missing: [...missing],
    scopes,
  };
}

export function getGhToken(opts?: { execImpl?: ExecImpl }): string {
  if (process.env.GITHUB_GRAPHQL_TOKEN) {
    return process.env.GITHUB_GRAPHQL_TOKEN;
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

export function ensureGhAuth(opts?: { execImpl?: ExecImpl }): {
  login: string;
  token: string;
} {
  const execImpl = opts?.execImpl ?? execFileSync;

  if (!checkGhInstalled({ execImpl })) {
    throw new GhAuthError(
      "not_installed",
      "gh CLI가 설치되어 있지 않습니다. https://cli.github.com 에서 설치하세요."
    );
  }

  const auth = checkGhAuthenticated({ execImpl });
  if (!auth.authenticated) {
    throw new GhAuthError(
      "not_authenticated",
      "gh auth login --scopes repo,read:org,project 를 실행하세요."
    );
  }

  const scopeCheck = checkGhScopes({ execImpl });
  if (!scopeCheck.valid) {
    throw new GhAuthError(
      "missing_scopes",
      `gh auth refresh --scopes repo,read:org,project 를 실행하세요. (missing: ${scopeCheck.missing.join(", ")})`
    );
  }

  const token = getGhToken({ execImpl });
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
