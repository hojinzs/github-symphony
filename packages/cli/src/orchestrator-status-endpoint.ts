import { readFile } from "node:fs/promises";
import { orchestratorPortPath } from "./config.js";

export async function resolveProjectOrchestratorStatusBaseUrl(input: {
  configDir: string;
  projectId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<string | null> {
  const env = input.env ?? process.env;
  const explicitBaseUrl = env.ORCHESTRATOR_STATUS_BASE_URL;
  if (explicitBaseUrl) {
    return explicitBaseUrl;
  }

  const host = env.ORCHESTRATOR_STATUS_HOST ?? "127.0.0.1";
  const port =
    env.ORCHESTRATOR_STATUS_PORT ??
    (await readProjectStatusPort(input.configDir, input.projectId));

  if (!port) {
    return null;
  }

  const urlHost =
    host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${urlHost}:${port}`;
}

async function readProjectStatusPort(
  configDir: string,
  projectId: string
): Promise<string | null> {
  try {
    const raw = await readFile(orchestratorPortPath(configDir, projectId), "utf8");
    const port = raw.trim();
    return port.length > 0 ? port : null;
  } catch {
    return null;
  }
}
