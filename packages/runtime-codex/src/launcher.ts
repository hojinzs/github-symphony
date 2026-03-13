import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  launchCodexAppServer,
  prepareCodexRuntimePlan,
  type CodexRuntimeConfig,
} from "./runtime.js";

export class LocalRuntimeLauncherError extends Error {}

export function resolveLocalRuntimeLaunchConfig(
  env: NodeJS.ProcessEnv = process.env
): CodexRuntimeConfig {
  const tenantId = env.TENANT_ID ?? env.CODEX_TENANT_ID;
  const workingDirectory = env.WORKING_DIRECTORY;

  if (!tenantId) {
    throw new LocalRuntimeLauncherError(
      "TENANT_ID or CODEX_TENANT_ID is required."
    );
  }

  if (!workingDirectory) {
    throw new LocalRuntimeLauncherError("WORKING_DIRECTORY is required.");
  }

  return {
    tenantId,
    workingDirectory,
    githubToken: env.GITHUB_GRAPHQL_TOKEN,
    githubTokenBrokerUrl: env.GITHUB_TOKEN_BROKER_URL,
    githubTokenBrokerSecret: env.GITHUB_TOKEN_BROKER_SECRET,
    githubTokenCachePath: env.GITHUB_TOKEN_CACHE_PATH,
    agentEnv: readDirectAgentEnvironment(env),
    agentCredentialBrokerUrl: env.AGENT_CREDENTIAL_BROKER_URL,
    agentCredentialBrokerSecret: env.AGENT_CREDENTIAL_BROKER_SECRET,
    agentCredentialCachePath: env.AGENT_CREDENTIAL_CACHE_PATH,
    githubProjectId: env.GITHUB_PROJECT_ID,
    githubGraphqlApiUrl: env.GITHUB_GRAPHQL_API_URL,
  };
}

export async function runLocalRuntimeLauncher(
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const launcherEnv = loadLauncherEnvironment(env);
  const config = resolveLocalRuntimeLaunchConfig(launcherEnv);
  const plan = await prepareCodexRuntimePlan(config);
  emitLaunchSummary(config);
  const child = launchCodexAppServer(plan);

  process.stdout.write(
    `[worker] codex app-server started (pid: ${child.pid ?? "unknown"})\n`
  );
  child.stdout?.pipe(process.stdout);
  child.stderr?.pipe(process.stderr);

  return await waitForChildProcess(child);
}

export function loadLauncherEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd()
): NodeJS.ProcessEnv {
  const mergedEnv = {
    ...readEnvFile(
      resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env")
    ),
    ...readEnvFile(resolve(cwd, ".env")),
    ...env,
  };

  return mergedEnv;
}

function readDirectAgentEnvironment(
  env: NodeJS.ProcessEnv
): Record<string, string> | undefined {
  const agentEnv: Record<string, string> = {};

  for (const key of [
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_ORG_ID",
    "OPENAI_PROJECT",
  ]) {
    const value = env[key];

    if (value) {
      agentEnv[key] = value;
    }
  }

  return Object.keys(agentEnv).length ? agentEnv : undefined;
}

function waitForChildProcess(
  child: ReturnType<typeof launchCodexAppServer>
): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(
          new LocalRuntimeLauncherError(`codex app-server exited on ${signal}.`)
        );
        return;
      }

      resolve(code ?? 0);
    });
  });
}

async function main(): Promise<void> {
  const exitCode = await runLocalRuntimeLauncher(process.env);
  process.exitCode = exitCode;
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) {
    return {};
  }

  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .reduce<Record<string, string>>((result, line) => {
      const separatorIndex = line.indexOf("=");
      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();

      if (key) {
        result[key] = value;
      }

      return result;
    }, {});
}

function emitLaunchSummary(config: CodexRuntimeConfig) {
  const githubAuthMode = config.githubToken
    ? "direct token"
    : config.githubTokenBrokerUrl && config.githubTokenBrokerSecret
      ? "broker"
      : "missing";
  const agentAuthMode = config.agentEnv?.OPENAI_API_KEY
    ? "direct env"
    : config.agentCredentialBrokerUrl && config.agentCredentialBrokerSecret
      ? "broker"
      : "local codex auth or inherited environment";

  process.stdout.write(
    [
      "[worker] starting local codex runtime",
      `[worker] tenant: ${config.tenantId}`,
      `[worker] cwd: ${config.workingDirectory}`,
      `[worker] github project: ${config.githubProjectId ?? "(unset)"}`,
      `[worker] github auth: ${githubAuthMode}`,
      `[worker] agent auth: ${agentAuthMode}`,
      "[worker] note: codex app-server does not proactively read GitHub issues.",
      "[worker] note: it waits for a client request or tool invocation.",
    ].join("\n") + "\n"
  );
}
