import { writeSync } from "node:fs";

const DEFAULT_GITHUB_GIT_HOST = "github.com";
const DEFAULT_GITHUB_GIT_USERNAME = "x-access-token";

export type GitCredentialRequest = Record<string, string>;

export type GitCredentialHelperConfig = {
  token?: string;
  gitHost?: string;
  gitUsername?: string;
};

export async function resolveGitCredential(
  request: GitCredentialRequest,
  config: GitCredentialHelperConfig
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
  if (!config.token) {
    throw new Error(
      "GITHUB_GRAPHQL_TOKEN is required for host Git publication."
    );
  }

  return formatGitCredentialResponse({
    protocol: requestProtocol || "https",
    host: requestHost,
    username: config.gitUsername ?? DEFAULT_GITHUB_GIT_USERNAME,
    password: config.token,
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
    gitHost: env.GITHUB_GIT_HOST,
    gitUsername: env.GITHUB_GIT_USERNAME,
  };
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
