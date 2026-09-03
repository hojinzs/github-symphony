import {
  resolveGitHubGraphQLToken,
  type GitHubGraphQLToolConfig,
} from "@gh-symphony/tool-github-graphql";
import { writeSync } from "node:fs";

const DEFAULT_GITHUB_GIT_HOST = "github.com";
const DEFAULT_GITHUB_GIT_USERNAME = "x-access-token";
const DEFAULT_TOKEN_BROKER_TIMEOUT_MS = 5_000;
const MAX_TOKEN_BROKER_TIMEOUT_MS = 2_147_483_647;

export type GitCredentialRequest = Record<string, string>;

export type GitCredentialHelperConfig = Pick<
  GitHubGraphQLToolConfig,
  "token" | "tokenBrokerUrl" | "tokenBrokerSecret" | "tokenCachePath"
> & {
  gitHost?: string;
  gitUsername?: string;
  tokenBrokerTimeoutMs?: number;
};

export async function resolveGitCredential(
  request: GitCredentialRequest,
  config: GitCredentialHelperConfig,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const requestHost = request.host?.trim();
  const requestProtocol = request.protocol?.trim();

  if (!requestHost || (requestProtocol && requestProtocol !== "https")) {
    return "";
  }

  const expectedHost = normalizeGitHost(
    config.gitHost ?? DEFAULT_GITHUB_GIT_HOST
  );

  if (normalizeGitHost(requestHost) !== expectedHost) {
    return "";
  }

  const tokenBrokerTimeoutMs =
    config.tokenBrokerTimeoutMs ?? DEFAULT_TOKEN_BROKER_TIMEOUT_MS;
  const tokenBrokerUrl = config.tokenBrokerUrl;
  const brokerFetch: typeof fetch = (input, init) =>
    fetchImpl(input, {
      ...init,
      signal: AbortSignal.timeout(tokenBrokerTimeoutMs),
    });

  let token: string;
  try {
    token = await resolveGitHubGraphQLToken(config, {
      fetchImpl: brokerFetch,
    });
  } catch (error) {
    if (tokenBrokerUrl && isTimeoutError(error)) {
      throw new Error(
        `Git credential token broker request to ${tokenBrokerUrl} timed out after ${tokenBrokerTimeoutMs}ms.`,
        { cause: error }
      );
    }
    throw error;
  }

  return formatGitCredentialResponse({
    protocol: requestProtocol || "https",
    host: requestHost,
    username: config.gitUsername ?? DEFAULT_GITHUB_GIT_USERNAME,
    password: token,
  });
}

export function parseGitCredentialRequest(
  rawInput: string
): GitCredentialRequest {
  return rawInput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce<GitCredentialRequest>((request, line) => {
      const separatorIndex = line.indexOf("=");

      if (separatorIndex === -1) {
        return request;
      }

      const key = line.slice(0, separatorIndex);
      const value = line.slice(separatorIndex + 1);
      request[key] = value;
      return request;
    }, {});
}

export function formatGitCredentialResponse(
  value: Record<string, string>
): string {
  return `${Object.entries(value)
    .map(([key, entry]) => `${key}=${entry}`)
    .join("\n")}\n\n`;
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

export async function runGitCredentialHelper(): Promise<void> {
  const request = parseGitCredentialRequest(await readStdin());
  const response = await resolveGitCredential(
    request,
    resolveGitCredentialHelperConfig(process.env)
  );

  process.stdout.write(response);
}

export function resolveGitCredentialHelperConfig(
  env: NodeJS.ProcessEnv
): GitCredentialHelperConfig {
  return {
    token: env.GITHUB_GRAPHQL_TOKEN,
    tokenBrokerUrl: env.GITHUB_TOKEN_BROKER_URL,
    tokenBrokerSecret: env.GITHUB_TOKEN_BROKER_SECRET,
    tokenCachePath: env.GITHUB_TOKEN_CACHE_PATH,
    gitHost: env.GITHUB_GIT_HOST,
    gitUsername: env.GITHUB_GIT_USERNAME,
    tokenBrokerTimeoutMs: parseGitCredentialBrokerTimeoutMs(
      env.GITHUB_TOKEN_BROKER_TIMEOUT_MS
    ),
  };
}

export function parseGitCredentialBrokerTimeoutMs(
  value: string | number | undefined
): number | undefined {
  if (
    value === undefined ||
    (typeof value === "string" && value.trim() === "")
  ) {
    return undefined;
  }

  const timeoutMs = typeof value === "number" ? value : Number(value);
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_TOKEN_BROKER_TIMEOUT_MS
  ) {
    throw new Error(
      `GITHUB_TOKEN_BROKER_TIMEOUT_MS must be a positive integer no greater than ${MAX_TOKEN_BROKER_TIMEOUT_MS}; received ${JSON.stringify(value)}.`
    );
  }

  return timeoutMs;
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  runGitCredentialHelper().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    writeSync(2, `${message}\n`);
    process.exit(1);
  });
}

function normalizeGitHost(host: string): string {
  return host.trim().toLowerCase();
}

function isTimeoutError(error: unknown): boolean {
  for (let cursor = error; cursor instanceof Error; cursor = cursor.cause) {
    if (cursor.name === "TimeoutError") {
      return true;
    }
  }

  return false;
}
