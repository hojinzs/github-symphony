import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  buildGitHubOAuthAuthorizationUrl,
  exchangeGitHubOAuthCode
} from "./github-oauth";
import { resolveControlPlaneBaseUrl } from "./control-plane-url";

const OPERATOR_SESSION_COOKIE = "github-symphony-operator-session";
const OPERATOR_AUTH_STATE_COOKIE = "github-symphony-operator-auth";
const DEFAULT_SIGN_IN_PATH = "/setup/github";
const OPERATOR_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const OPERATOR_AUTH_STATE_TTL_MS = 15 * 60 * 1000;

const GITHUB_OPERATOR_CLIENT_ID_ENV = "GITHUB_OPERATOR_CLIENT_ID";
const GITHUB_OPERATOR_CLIENT_SECRET_ENV = "GITHUB_OPERATOR_CLIENT_SECRET";
const GITHUB_OPERATOR_ALLOWED_LOGINS_ENV = "GITHUB_OPERATOR_ALLOWED_LOGINS";
const OPERATOR_SESSION_SECRET_ENV = "OPERATOR_SESSION_SECRET";
const PLATFORM_SECRETS_KEY_ENV = "PLATFORM_SECRETS_KEY";

type SignedCookiePayload<T> = T & {
  expiresAt: number;
};

export type TrustedOperator = {
  githubLogin: string;
  githubUserId: string;
};

export type OperatorSession = TrustedOperator & {
  expiresAt: number;
};

export type PendingOperatorAuth = {
  state: string;
  nextPath: string;
  expiresAt: number;
};

export type OperatorAuthReadiness = {
  isConfigured: boolean;
  allowedLogins: string[];
  error: string | null;
};

type OperatorAuthConfig = {
  clientId: string;
  clientSecret: string;
  allowedLogins: string[];
  sessionSecret: string;
};

export class OperatorAuthConfigurationError extends Error {}

export class OperatorAuthorizationError extends Error {}

export function getOperatorSessionCookieName(): string {
  return OPERATOR_SESSION_COOKIE;
}

export function getPendingOperatorAuthCookieName(): string {
  return OPERATOR_AUTH_STATE_COOKIE;
}

export function getOperatorAuthStateMaxAgeSeconds(): number {
  return Math.floor(OPERATOR_AUTH_STATE_TTL_MS / 1000);
}

export function getOperatorSessionMaxAgeSeconds(): number {
  return Math.floor(OPERATOR_SESSION_TTL_MS / 1000);
}

export function normalizeOperatorNextPath(
  value: string | null | undefined,
  fallbackPath = DEFAULT_SIGN_IN_PATH
): string {
  if (typeof value !== "string" || value.length === 0) {
    return fallbackPath;
  }

  if (!value.startsWith("/") || value.startsWith("//")) {
    return fallbackPath;
  }

  return value;
}

export function buildOperatorSignInPath(
  nextPath: string,
  error?: string | null
): string {
  const url = new URL("http://github-symphony.local/sign-in");
  url.searchParams.set("next", normalizeOperatorNextPath(nextPath));

  if (error) {
    url.searchParams.set("error", error);
  }

  return `${url.pathname}${url.search}`;
}

export function buildOperatorAuthCallbackUrl(request: Request): string {
  return `${resolveControlPlaneBaseUrl(request)}/api/auth/github/callback`;
}

export function getOperatorAuthReadiness(
  env: Record<string, string | undefined> = process.env
): OperatorAuthReadiness {
  const allowedLogins = parseAllowedLogins(env[GITHUB_OPERATOR_ALLOWED_LOGINS_ENV]);
  const missing: string[] = [];

  if (!env[GITHUB_OPERATOR_CLIENT_ID_ENV]) {
    missing.push(GITHUB_OPERATOR_CLIENT_ID_ENV);
  }

  if (!env[GITHUB_OPERATOR_CLIENT_SECRET_ENV]) {
    missing.push(GITHUB_OPERATOR_CLIENT_SECRET_ENV);
  }

  if (!resolveOperatorSessionSecret(env)) {
    missing.push(`${OPERATOR_SESSION_SECRET_ENV} or ${PLATFORM_SECRETS_KEY_ENV}`);
  }

  return {
    isConfigured: missing.length === 0,
    allowedLogins,
    error:
      missing.length > 0
        ? `Operator sign-in is not configured. Set ${missing.join(", ")}.`
        : null
  };
}

export function buildOperatorAuthorizationStart(
  request: Request,
  nextPath: string,
  env: Record<string, string | undefined> = process.env
): {
  authorizationUrl: string;
  cookieValue: string;
} {
  const config = loadOperatorAuthConfig(env);
  const state = randomBytes(24).toString("base64url");
  const normalizedNextPath = normalizeOperatorNextPath(nextPath);

  return {
    authorizationUrl: buildGitHubOAuthAuthorizationUrl({
      clientId: config.clientId,
      redirectUri: buildOperatorAuthCallbackUrl(request),
      state
    }),
    cookieValue: encodeSignedCookie<PendingOperatorAuth>(
      {
        state,
        nextPath: normalizedNextPath,
        expiresAt: Date.now() + OPERATOR_AUTH_STATE_TTL_MS
      },
      config.sessionSecret
    )
  };
}

export function createOperatorSessionCookieValue(
  operator: TrustedOperator,
  env: Record<string, string | undefined> = process.env
): string {
  const config = loadOperatorAuthConfig(env);

  return encodeSignedCookie<OperatorSession>(
    {
      githubLogin: operator.githubLogin,
      githubUserId: operator.githubUserId,
      expiresAt: Date.now() + OPERATOR_SESSION_TTL_MS
    },
    config.sessionSecret
  );
}

export function parsePendingOperatorAuthCookie(
  value: string | null,
  env: Record<string, string | undefined> = process.env
): PendingOperatorAuth | null {
  const sessionSecret = resolveOperatorSessionSecret(env);

  if (!sessionSecret) {
    return null;
  }

  return decodeSignedCookie<PendingOperatorAuth>(value, sessionSecret);
}

export function parseOperatorSessionCookie(
  value: string | null,
  env: Record<string, string | undefined> = process.env
): OperatorSession | null {
  const sessionSecret = resolveOperatorSessionSecret(env);

  if (!sessionSecret) {
    return null;
  }

  return decodeSignedCookie<OperatorSession>(value, sessionSecret);
}

export async function authenticateTrustedOperator(
  input: {
    code: string;
    redirectUri: string;
    env?: Record<string, string | undefined>;
    fetchImpl?: typeof fetch;
  }
): Promise<TrustedOperator> {
  const config = loadOperatorAuthConfig(input.env);
  const token = await exchangeGitHubOAuthCode(
    {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      code: input.code,
      redirectUri: input.redirectUri
    },
    input.fetchImpl
  );
  const operator = await fetchGitHubUserProfile(token.accessToken, input.fetchImpl ?? fetch);
  const normalizedLogin = operator.githubLogin.toLowerCase();

  if (
    config.allowedLogins.length > 0 &&
    !config.allowedLogins.includes(normalizedLogin)
  ) {
    throw new OperatorAuthorizationError(
      `GitHub user "${operator.githubLogin}" is not allowed to operate this control plane.`
    );
  }

  return operator;
}

function loadOperatorAuthConfig(
  env: Record<string, string | undefined> = process.env
): OperatorAuthConfig {
  const readiness = getOperatorAuthReadiness(env);

  if (!readiness.isConfigured) {
    throw new OperatorAuthConfigurationError(
      readiness.error ?? "Operator sign-in is not configured."
    );
  }

  return {
    clientId: env[GITHUB_OPERATOR_CLIENT_ID_ENV] as string,
    clientSecret: env[GITHUB_OPERATOR_CLIENT_SECRET_ENV] as string,
    allowedLogins: readiness.allowedLogins,
    sessionSecret: resolveOperatorSessionSecret(env) as string
  };
}

function resolveOperatorSessionSecret(
  env: Record<string, string | undefined>
): string | null {
  return env[OPERATOR_SESSION_SECRET_ENV] ?? env[PLATFORM_SECRETS_KEY_ENV] ?? null;
}

function parseAllowedLogins(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function encodeSignedCookie<T extends Record<string, string | number>>(
  payload: SignedCookiePayload<T>,
  secret: string
): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createCookieSignature(encodedPayload, secret);

  return `${encodedPayload}.${signature}`;
}

function decodeSignedCookie<T extends Record<string, string | number>>(
  value: string | null,
  secret: string
): SignedCookiePayload<T> | null {
  if (!value) {
    return null;
  }

  const separatorIndex = value.lastIndexOf(".");

  if (separatorIndex <= 0) {
    return null;
  }

  const encodedPayload = value.slice(0, separatorIndex);
  const signature = value.slice(separatorIndex + 1);
  const expectedSignature = createCookieSignature(encodedPayload, secret);

  if (!constantTimeEquals(signature, expectedSignature)) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as
      | SignedCookiePayload<T>
      | undefined;

    if (!payload || typeof payload.expiresAt !== "number") {
      return null;
    }

    if (payload.expiresAt <= Date.now()) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function createCookieSignature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function constantTimeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

async function fetchGitHubUserProfile(
  token: string,
  fetchImpl: typeof fetch
): Promise<TrustedOperator> {
  const response = await fetchImpl("https://api.github.com/user", {
    method: "GET",
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "github-symphony"
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub operator lookup failed with status ${response.status}.`);
  }

  const payload = (await response.json()) as {
    id?: number;
    login?: string;
  };

  if (!payload.id || !payload.login) {
    throw new Error("GitHub operator lookup returned incomplete profile data.");
  }

  return {
    githubLogin: payload.login,
    githubUserId: String(payload.id)
  };
}
