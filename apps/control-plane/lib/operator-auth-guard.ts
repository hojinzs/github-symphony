import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { NextResponse } from "next/server";
import {
  buildOperatorSignInPath,
  normalizeOperatorNextPath,
  parseOperatorSessionCookie,
  type OperatorSession
} from "./operator-auth";

export class OperatorAuthRequiredError extends Error {
  constructor(readonly nextPath: string) {
    super("Trusted operator sign-in is required.");
  }
}

export async function requireOperatorPageSession(
  nextPath: string
): Promise<OperatorSession> {
  const session = await loadOperatorPageSession();

  if (!session) {
    redirect(buildOperatorSignInPath(nextPath));
  }

  return session;
}

export function requireOperatorRequestSession(
  request: Request
): OperatorSession {
  const session = parseOperatorSessionCookie(
    readCookie(request.headers.get("cookie"), "github-symphony-operator-session")
  );

  if (!session) {
    throw new OperatorAuthRequiredError(buildOperatorReturnPath(request));
  }

  return session;
}

export function createOperatorAuthRedirectResponse(
  request: Request,
  nextPath: string,
  error?: string | null
): NextResponse {
  return NextResponse.redirect(
    new URL(buildOperatorSignInPath(nextPath, error), request.url),
    303
  );
}

export function createOperatorAuthJsonResponse(
  error: OperatorAuthRequiredError
): NextResponse {
  return NextResponse.json(
    {
      error: error.message,
      signInPath: buildOperatorSignInPath(error.nextPath)
    },
    {
      status: 401
    }
  );
}

async function loadOperatorPageSession(): Promise<OperatorSession | null> {
  const cookieStore = await cookies();

  return parseOperatorSessionCookie(
    cookieStore.get("github-symphony-operator-session")?.value ?? null
  );
}

function buildOperatorReturnPath(request: Request): string {
  const requestUrl = new URL(request.url);
  const referer = request.headers.get("referer");

  if (referer) {
    try {
      const refererUrl = new URL(referer);

      if (refererUrl.origin === requestUrl.origin) {
        return normalizeOperatorNextPath(
          `${refererUrl.pathname}${refererUrl.search}`,
          `${requestUrl.pathname}${requestUrl.search}`
        );
      }
    } catch {
      // Ignore malformed referer values and fall back to the request path.
    }
  }

  return normalizeOperatorNextPath(`${requestUrl.pathname}${requestUrl.search}`);
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) {
    return null;
  }

  const prefix = `${name}=`;

  for (const part of header.split(";")) {
    const trimmed = part.trim();

    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length);
    }
  }

  return null;
}
