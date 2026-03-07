const CONTROL_PLANE_BASE_URL_ENV = "CONTROL_PLANE_BASE_URL";

export function resolveControlPlaneBaseUrl(
  request: Request,
  env: Record<string, string | undefined> = process.env
): string {
  const configuredBaseUrl = env[CONTROL_PLANE_BASE_URL_ENV];

  if (configuredBaseUrl) {
    return configuredBaseUrl.replace(/\/+$/, "");
  }

  const url = new URL(request.url);
  const forwardedProtocol = request.headers.get("x-forwarded-proto");
  const forwardedHost =
    request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const protocol = forwardedProtocol ?? url.protocol.replace(":", "");
  const host = forwardedHost ?? url.host;

  return `${protocol}://${host}`;
}
