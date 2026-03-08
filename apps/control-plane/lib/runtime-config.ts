const SYMPHONY_RUNTIME_DRIVER_ENV = "SYMPHONY_RUNTIME_DRIVER";
const CONTROL_PLANE_RUNTIME_URL_ENV = "CONTROL_PLANE_RUNTIME_URL";

export const DEFAULT_DOCKER_RUNTIME_URL = "http://host.docker.internal:3000";
export const DEFAULT_LOCAL_RUNTIME_URL = "http://127.0.0.1:3000";

export type RuntimeDriver = "docker" | "local";

export class RuntimeConfigurationError extends Error {}

export function resolveRuntimeDriver(
  env: Record<string, string | undefined> = process.env
): RuntimeDriver {
  const configuredDriver = env[SYMPHONY_RUNTIME_DRIVER_ENV]?.trim();

  if (!configuredDriver) {
    return "docker";
  }

  if (configuredDriver === "docker" || configuredDriver === "local") {
    return configuredDriver;
  }

  throw new RuntimeConfigurationError(
    `${SYMPHONY_RUNTIME_DRIVER_ENV} must be either "docker" or "local".`
  );
}

export function resolveControlPlaneRuntimeUrl(
  env: Record<string, string | undefined> = process.env,
  runtimeDriver = resolveRuntimeDriver(env)
): string {
  const configuredBaseUrl = env[CONTROL_PLANE_RUNTIME_URL_ENV] ?? env.CONTROL_PLANE_BASE_URL;

  if (configuredBaseUrl) {
    return configuredBaseUrl.replace(/\/+$/, "");
  }

  return runtimeDriver === "docker"
    ? DEFAULT_DOCKER_RUNTIME_URL
    : DEFAULT_LOCAL_RUNTIME_URL;
}
