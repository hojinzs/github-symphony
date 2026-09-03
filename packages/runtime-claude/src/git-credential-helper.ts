import {
  resolveGitHubGraphQLToken,
  type GitHubGraphQLToolConfig,
} from "@gh-symphony/tool-github-graphql";
import { writeSync } from "node:fs";

const DEFAULT_TOKEN_BROKER_TIMEOUT_MS = 5_000;
const MAX_TOKEN_BROKER_TIMEOUT_MS = 2_147_483_647;

export type GitCredentialHelperConfig = Pick<
  GitHubGraphQLToolConfig,
  "tokenBrokerUrl" | "tokenBrokerSecret" | "tokenCachePath"
> & {
  tokenBrokerTimeoutMs?: number;
};

export async function resolveGitCredential(
  request: Record<string, string>,
  config: GitCredentialHelperConfig,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  if (request.host?.toLowerCase() !== "github.com") return "";

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
    token = await resolveGitHubGraphQLToken(config, { fetchImpl: brokerFetch });
  } catch (error) {
    if (tokenBrokerUrl && isTimeoutError(error)) {
      throw new Error(
        `Git credential token broker request to ${tokenBrokerUrl} timed out after ${tokenBrokerTimeoutMs}ms.`,
        { cause: error }
      );
    }
    throw error;
  }

  return `protocol=${request.protocol ?? "https"}\nhost=${request.host}\nusername=x-access-token\npassword=${token}\n\n`;
}

export function resolveGitCredentialHelperConfig(
  env: NodeJS.ProcessEnv
): GitCredentialHelperConfig {
  return {
    tokenBrokerUrl: env.GITHUB_TOKEN_BROKER_URL,
    tokenBrokerSecret: env.GITHUB_TOKEN_BROKER_SECRET,
    tokenCachePath: env.GITHUB_TOKEN_CACHE_PATH,
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

async function main(): Promise<void> {
  const request = Object.fromEntries(
    (await readStdin())
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        const separator = line.indexOf("=");
        return separator === -1
          ? []
          : [[line.slice(0, separator), line.slice(separator + 1)]];
      })
  );
  const response = await resolveGitCredential(
    request,
    resolveGitCredentialHelperConfig(process.env)
  );
  process.stdout.write(response);
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    writeSync(2, `${message}\n`);
    process.exit(1);
  });
}

function isTimeoutError(error: unknown): boolean {
  for (let cursor = error; cursor instanceof Error; cursor = cursor.cause) {
    if (cursor.name === "TimeoutError") return true;
  }
  return false;
}
