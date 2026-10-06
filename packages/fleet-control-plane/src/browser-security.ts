import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { OPERATOR_ACTOR } from "@gh-symphony/management-protocol";
import { resolveHttpsOrigin, type FleetConfig } from "./config.js";
import { FleetError } from "./enrollment.js";

export const BROWSER_SESSION_COOKIE = "__Host-gh-symphony-fleet-session";
export const BROWSER_SESSION_LIFETIME_MS = 8 * 60 * 60_000;
export interface BrowserRequest {
  method: string;
  origin?: string | readonly string[];
  cookie?: string | readonly string[];
  csrfToken?: string | readonly string[];
}
export interface BrowserSession {
  sessionId: string;
  csrfToken: string;
  expiresAt: string;
  setCookie: string;
}
export interface BrowserSecurityOptions {
  sessionLifetimeMs?: number;
  maximumSessions?: number;
  now?: () => number;
}
export interface BrowserSecurity {
  issueSession(): BrowserSession;
  revokeSession(sessionId: string): void;
  resolveActor(request: BrowserRequest): typeof OPERATOR_ACTOR;
}
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}
function validToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}
function denied(): never {
  throw new FleetError(
    "unauthenticated",
    "Browser mutation requires a valid same-origin CSRF session"
  );
}
function cookieToken(cookie: BrowserRequest["cookie"]): string {
  if (typeof cookie !== "string" || cookie.length > 4096) return denied();
  const values = cookie.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    return separator >= 0 &&
      part.slice(0, separator).trim() === BROWSER_SESSION_COOKIE
      ? [part.slice(separator + 1).trim()]
      : [];
  });
  if (values.length !== 1 || !validToken(values[0])) return denied();
  return values[0];
}

/** No human login: the private listener is the read boundary; mutations need CSRF. */
export function createBrowserSecurity(
  config: Pick<FleetConfig, "publicOrigin">,
  options: BrowserSecurityOptions = {}
): BrowserSecurity {
  const publicOrigin = resolveHttpsOrigin(config.publicOrigin);
  const lifetime = options.sessionLifetimeMs ?? BROWSER_SESSION_LIFETIME_MS;
  const maximum = options.maximumSessions ?? 256;
  if (
    !Number.isSafeInteger(lifetime) ||
    lifetime < 1000 ||
    lifetime > 7 * 24 * 60 * 60_000 ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 10_000
  ) {
    throw new Error("Invalid browser session lifetime or capacity");
  }
  const now = options.now ?? Date.now;
  const sessions = new Map<string, { csrf: Buffer; expiresAt: number }>();
  return {
    issueSession() {
      const time = now();
      for (const [key, session] of sessions) {
        if (session.expiresAt <= time) sessions.delete(key);
      }
      if (sessions.size >= maximum) {
        sessions.delete(sessions.keys().next().value!);
      }
      const sessionId = randomBytes(32).toString("base64url");
      const csrfToken = randomBytes(32).toString("base64url");
      const expiresAt = time + lifetime;
      sessions.set(digest(sessionId).toString("hex"), {
        csrf: digest(csrfToken),
        expiresAt,
      });
      return {
        sessionId,
        csrfToken,
        expiresAt: new Date(expiresAt).toISOString(),
        setCookie: `${BROWSER_SESSION_COOKIE}=${sessionId}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(lifetime / 1000)}`,
      };
    },
    revokeSession(sessionId) {
      if (validToken(sessionId))
        sessions.delete(digest(sessionId).toString("hex"));
    },
    resolveActor(request) {
      if (request.method === "GET" || request.method === "HEAD")
        return OPERATOR_ACTOR;
      if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
        throw new FleetError("invalid_input", "Unsupported browser method");
      }
      // Never trust forwarded headers, a submitted actor, or a claimed browser identity.
      if (request.origin !== publicOrigin) return denied();
      const sessionId = cookieToken(request.cookie);
      if (!validToken(request.csrfToken)) return denied();
      const key = digest(sessionId).toString("hex");
      const session = sessions.get(key);
      if (!session || session.expiresAt <= now()) {
        sessions.delete(key);
        return denied();
      }
      if (!timingSafeEqual(session.csrf, digest(request.csrfToken)))
        return denied();
      return OPERATOR_ACTOR;
    },
  };
}
