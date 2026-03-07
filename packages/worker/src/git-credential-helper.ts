import { resolveGitHubGraphQLToken, type GitHubGraphQLToolConfig } from "./github-graphql-tool.js";

const DEFAULT_GITHUB_GIT_HOST = "github.com";
const DEFAULT_GITHUB_GIT_USERNAME = "x-access-token";

export type GitCredentialRequest = Record<string, string>;

export type GitCredentialHelperConfig = Pick<
  GitHubGraphQLToolConfig,
  "token" | "tokenBrokerUrl" | "tokenBrokerSecret" | "tokenCachePath"
> & {
  gitHost?: string;
  gitUsername?: string;
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

  const expectedHost = normalizeGitHost(config.gitHost ?? DEFAULT_GITHUB_GIT_HOST);

  if (normalizeGitHost(requestHost) !== expectedHost) {
    return "";
  }

  const token = await resolveGitHubGraphQLToken(config, {
    fetchImpl
  });

  return formatGitCredentialResponse({
    protocol: requestProtocol || "https",
    host: requestHost,
    username: config.gitUsername ?? DEFAULT_GITHUB_GIT_USERNAME,
    password: token
  });
}

export function parseGitCredentialRequest(rawInput: string): GitCredentialRequest {
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

async function main(): Promise<void> {
  const request = parseGitCredentialRequest(await readStdin());
  const response = await resolveGitCredential(request, {
    token: process.env.GITHUB_GRAPHQL_TOKEN,
    tokenBrokerUrl: process.env.GITHUB_TOKEN_BROKER_URL,
    tokenBrokerSecret: process.env.GITHUB_TOKEN_BROKER_SECRET,
    tokenCachePath: process.env.GITHUB_TOKEN_CACHE_PATH,
    gitHost: process.env.GITHUB_GIT_HOST,
    gitUsername: process.env.GITHUB_GIT_USERNAME
  });

  process.stdout.write(response);
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

function normalizeGitHost(host: string): string {
  return host.trim().toLowerCase();
}
