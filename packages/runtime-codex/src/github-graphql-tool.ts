import { readFile, writeFile } from "node:fs/promises";

const DEFAULT_GITHUB_GRAPHQL_API_URL = "https://api.github.com/graphql";
const TOKEN_REUSE_WINDOW_MS = 60 * 1000;

export type GitHubGraphQLInvocation = {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
};

export type GitHubGraphQLToolConfig = {
  token?: string;
  apiUrl?: string;
  tokenBrokerUrl?: string;
  tokenBrokerSecret?: string;
  tokenCachePath?: string;
};

export async function executeGitHubGraphQL(
  invocation: GitHubGraphQLInvocation,
  config: GitHubGraphQLToolConfig,
  fetchImpl: typeof fetch = fetch
): Promise<unknown> {
  const token = await resolveGitHubGraphQLToken(config, {
    fetchImpl,
  });
  const response = await fetchImpl(
    config.apiUrl ?? DEFAULT_GITHUB_GRAPHQL_API_URL,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(invocation),
    }
  );

  const payload = (await response.json()) as {
    errors?: Array<{ message: string }>;
  };

  if (!response.ok) {
    throw new Error(
      `GitHub GraphQL request failed with status ${response.status}: ${JSON.stringify(payload)}`
    );
  }

  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }

  return payload;
}

export async function resolveGitHubGraphQLToken(
  config: GitHubGraphQLToolConfig,
  dependencies: {
    fetchImpl?: typeof fetch;
    readFileImpl?: typeof readFile;
    writeFileImpl?: typeof writeFile;
    now?: Date;
  } = {}
): Promise<string> {
  if (config.token) {
    return config.token;
  }

  if (!config.tokenBrokerUrl || !config.tokenBrokerSecret) {
    throw new Error(
      "Either GITHUB_GRAPHQL_TOKEN or the runtime token broker configuration is required."
    );
  }

  const now = dependencies.now ?? new Date();
  const readFileImpl = dependencies.readFileImpl ?? readFile;
  const writeFileImpl = dependencies.writeFileImpl ?? writeFile;
  const cachedToken = config.tokenCachePath
    ? await readCachedToken(config.tokenCachePath, readFileImpl)
    : null;

  if (
    cachedToken &&
    cachedToken.expiresAt.getTime() - now.getTime() > TOKEN_REUSE_WINDOW_MS
  ) {
    return cachedToken.token;
  }

  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const response = await fetchImpl(config.tokenBrokerUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${config.tokenBrokerSecret}`,
    },
  });
  const payload = (await response.json()) as {
    token?: string;
    expiresAt?: string;
    error?: string;
  };

  if (!response.ok || !payload.token || !payload.expiresAt) {
    throw new Error(
      payload.error ??
        `Runtime token broker request failed with status ${response.status}.`
    );
  }

  if (config.tokenCachePath) {
    await writeFileImpl(config.tokenCachePath, JSON.stringify(payload), "utf8");
  }

  return payload.token;
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];

  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const rawInput = await readStdin();
  const invocation = JSON.parse(rawInput) as GitHubGraphQLInvocation;

  const result = await executeGitHubGraphQL(invocation, {
    token: process.env.GITHUB_GRAPHQL_TOKEN,
    apiUrl: process.env.GITHUB_GRAPHQL_API_URL,
    tokenBrokerUrl: process.env.GITHUB_TOKEN_BROKER_URL,
    tokenBrokerSecret: process.env.GITHUB_TOKEN_BROKER_SECRET,
    tokenCachePath: process.env.GITHUB_TOKEN_CACHE_PATH,
  });

  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

async function readCachedToken(
  path: string,
  readFileImpl: typeof readFile
): Promise<{ token: string; expiresAt: Date } | null> {
  try {
    const payload = JSON.parse(await readFileImpl(path, "utf8")) as {
      token?: string;
      expiresAt?: string;
    };

    if (!payload.token || !payload.expiresAt) {
      return null;
    }

    return {
      token: payload.token,
      expiresAt: new Date(payload.expiresAt),
    };
  } catch {
    return null;
  }
}
