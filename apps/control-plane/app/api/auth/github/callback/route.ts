import { NextResponse } from "next/server";
import {
  authenticateTrustedOperator,
  buildOperatorAuthCallbackUrl,
  buildOperatorSignInPath,
  createOperatorSessionCookieValue,
  getPendingOperatorAuthCookieName,
  getOperatorSessionCookieName,
  getOperatorSessionMaxAgeSeconds,
  normalizeOperatorNextPath,
  parsePendingOperatorAuthCookie
} from "../../../../../lib/operator-auth";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const pending = parsePendingOperatorAuthCookie(
    readCookie(request.headers.get("cookie"), getPendingOperatorAuthCookieName())
  );

  if (!code || !state || !pending || pending.state !== state) {
    return clearCookiesAndRedirect(
      request,
      buildOperatorSignInPath(
        pending?.nextPath ?? "/setup/github",
        "GitHub operator sign-in could not be verified. Start again."
      )
    );
  }

  try {
    const operator = await authenticateTrustedOperator({
      code,
      redirectUri: buildOperatorAuthCallbackUrl(request)
    });
    const response = NextResponse.redirect(
      new URL(normalizeOperatorNextPath(pending.nextPath), request.url),
      303
    );

    response.cookies.set(
      getOperatorSessionCookieName(),
      createOperatorSessionCookieValue(operator),
      {
        httpOnly: true,
        sameSite: "lax",
        secure: url.protocol === "https:",
        path: "/",
        maxAge: getOperatorSessionMaxAgeSeconds()
      }
    );
    response.cookies.set(getPendingOperatorAuthCookieName(), "", {
      httpOnly: true,
      sameSite: "lax",
      secure: url.protocol === "https:",
      path: "/",
      maxAge: 0
    });

    return response;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "GitHub operator sign-in failed.";

    return clearCookiesAndRedirect(
      request,
      buildOperatorSignInPath(pending.nextPath, message)
    );
  }
}

function clearCookiesAndRedirect(request: Request, path: string): NextResponse {
  const response = NextResponse.redirect(new URL(path, request.url), 303);
  const secure = new URL(request.url).protocol === "https:";

  response.cookies.set(getPendingOperatorAuthCookieName(), "", {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 0
  });
  response.cookies.set(getOperatorSessionCookieName(), "", {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 0
  });

  return response;
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
