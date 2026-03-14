type RefreshRequestOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

export function resolveOrchestratorStatusBaseUrl(
  env: NodeJS.ProcessEnv = process.env
): string {
  const host = env.ORCHESTRATOR_STATUS_HOST ?? "127.0.0.1";
  const port = env.ORCHESTRATOR_STATUS_PORT ?? "4680";
  const urlHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `http://${urlHost}:${port}`;
}

export async function requestOrchestratorRefresh(
  options: RefreshRequestOptions = {}
): Promise<boolean> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const signal = AbortSignal.timeout(timeoutMs);

  try {
    const response = await fetchImpl(
      `${resolveOrchestratorStatusBaseUrl(options.env)}/api/v1/refresh`,
      {
        method: "POST",
        signal,
      }
    );
    return response.ok;
  } catch {
    return false;
  }
}
