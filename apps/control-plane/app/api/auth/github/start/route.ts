import { NextResponse } from "next/server";
import {
  buildOperatorAuthorizationStart,
  buildOperatorSignInPath,
  getPendingOperatorAuthCookieName,
  getOperatorAuthStateMaxAgeSeconds,
  normalizeOperatorNextPath,
  OperatorAuthConfigurationError
} from "../../../../../lib/operator-auth";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const nextPath = normalizeOperatorNextPath(url.searchParams.get("next"));

  try {
    const authorization = buildOperatorAuthorizationStart(request, nextPath);
    const response = NextResponse.redirect(authorization.authorizationUrl, 303);

    response.cookies.set(getPendingOperatorAuthCookieName(), authorization.cookieValue, {
      httpOnly: true,
      sameSite: "lax",
      secure: url.protocol === "https:",
      path: "/",
      maxAge: getOperatorAuthStateMaxAgeSeconds()
    });

    return response;
  } catch (error) {
    const message =
      error instanceof OperatorAuthConfigurationError
        ? error.message
        : "Operator sign-in could not be started.";

    return NextResponse.redirect(
      new URL(buildOperatorSignInPath(nextPath, message), request.url),
      303
    );
  }
}
