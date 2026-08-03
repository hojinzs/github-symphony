import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  parse,
  print,
  Kind,
  type DefinitionNode,
  type FieldNode,
  type OperationDefinitionNode,
} from "graphql";
import {
  extractGitHubRateLimits,
  extractGraphQLRateLimitField,
  fingerprintGitHubToken,
  githubGraphQLRateLimitPolicy,
  isGitHubRateLimitResponse,
  parseGitHubRetryAfterMs,
  type GitHubGraphQLRateLimitPolicy,
  type GitHubGraphQLAttemptResult,
  type GitHubRateLimitPayload,
} from "./github-rate-limit.js";
import {
  validateGitHubGraphQLApiUrl,
  validateGitHubTokenBrokerUrl,
} from "./url-policy.js";

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
  rateLimitPolicy?: GitHubGraphQLRateLimitPolicy;
};

export async function executeGitHubGraphQL(
  invocation: GitHubGraphQLInvocation,
  config: GitHubGraphQLToolConfig,
  fetchImpl: typeof fetch = fetch
): Promise<unknown> {
  const token = await resolveGitHubGraphQLToken(config, {
    fetchImpl,
  });
  const apiUrl = validateGitHubGraphQLApiUrl(
    config.apiUrl ?? DEFAULT_GITHUB_GRAPHQL_API_URL
  );
  const instrumentedInvocation = instrumentGitHubGraphQLInvocation(invocation);
  const rateLimitPolicy =
    config.rateLimitPolicy ?? githubGraphQLRateLimitPolicy;
  const result = await rateLimitPolicy.execute(
    fingerprintGitHubToken(token),
    async (): Promise<
      GitHubGraphQLAttemptResult<
        {
          payload: GitHubGraphQLPayload;
          rateLimits: GitHubRateLimitPayload | null;
        },
        GitHubRateLimitPayload
      >
    > => {
      const response = await fetchImpl(apiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(instrumentedInvocation),
      });

      const payload = (await response.json()) as GitHubGraphQLPayload;
      const fieldRateLimits = extractGraphQLRateLimitField(
        isRecord(payload.data) ? payload.data.rateLimit : null
      );
      const rateLimits = extractGitHubRateLimits(
        response.headers,
        fieldRateLimits
      );

      if (!response.ok) {
        const details = JSON.stringify(payload);
        return {
          ok: false,
          status: response.status,
          details,
          rateLimits,
          retryAfterMs: parseGitHubRetryAfterMs(
            response.headers?.get?.("retry-after") ?? null
          ),
          rateLimited: isGitHubRateLimitResponse(
            response.status,
            details,
            response.headers
          ),
        };
      }

      return {
        ok: true,
        value: { payload, rateLimits },
        rateLimits,
      };
    }
  );

  if (!result.ok) {
    throw new Error(
      `GitHub GraphQL request failed with status ${result.status}: ${result.details}`
    );
  }

  const { payload, rateLimits } = result.value;
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }

  return rateLimits ? { ...payload, rateLimits } : payload;
}

type GitHubGraphQLPayload = {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
  [key: string]: unknown;
};

function instrumentGitHubGraphQLInvocation(
  invocation: GitHubGraphQLInvocation
): GitHubGraphQLInvocation {
  try {
    const document = parse(invocation.query);
    const definitions = document.definitions.map((definition) => {
      if (!shouldInstrumentOperation(definition, invocation.operationName)) {
        return definition;
      }

      if (
        definition.selectionSet.selections.some(
          (selection) =>
            selection.kind === "Field" && selection.name.value === "rateLimit"
        )
      ) {
        return definition;
      }

      return {
        ...definition,
        selectionSet: {
          ...definition.selectionSet,
          selections: [
            ...definition.selectionSet.selections,
            buildRateLimitField(),
          ],
        },
      };
    });

    return {
      ...invocation,
      query: print({ ...document, definitions }),
    };
  } catch {
    // Preserve the server's existing validation and error behavior for invalid
    // or provider-specific GraphQL documents that the local parser rejects.
    return invocation;
  }
}

function shouldInstrumentOperation(
  definition: DefinitionNode,
  operationName: string | undefined
): definition is OperationDefinitionNode {
  return (
    definition.kind === "OperationDefinition" &&
    definition.operation === "query" &&
    (operationName === undefined || definition.name?.value === operationName)
  );
}

function buildRateLimitField(): FieldNode {
  return {
    kind: Kind.FIELD,
    name: { kind: Kind.NAME, value: "rateLimit" },
    selectionSet: {
      kind: Kind.SELECTION_SET,
      selections: [
        {
          kind: Kind.FIELD,
          name: { kind: Kind.NAME, value: "cost" },
        },
        {
          kind: Kind.FIELD,
          name: { kind: Kind.NAME, value: "remaining" },
        },
        {
          kind: Kind.FIELD,
          name: { kind: Kind.NAME, value: "resetAt" },
        },
      ],
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function resolveGitHubGraphQLToken(
  config: GitHubGraphQLToolConfig,
  dependencies: {
    fetchImpl?: typeof fetch;
    chmodImpl?: typeof chmod;
    mkdirImpl?: typeof mkdir;
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
  const chmodImpl = dependencies.chmodImpl ?? chmod;
  const mkdirImpl = dependencies.mkdirImpl ?? mkdir;
  const readFileImpl = dependencies.readFileImpl ?? readFile;
  const writeFileImpl = dependencies.writeFileImpl ?? writeFile;
  const tokenCachePath = config.tokenCachePath;
  const cachedToken = tokenCachePath
    ? await readCachedToken(tokenCachePath, readFileImpl)
    : null;

  if (
    cachedToken &&
    tokenCachePath &&
    cachedToken.expiresAt.getTime() - now.getTime() > TOKEN_REUSE_WINDOW_MS
  ) {
    await chmodExistingSecretFile(tokenCachePath, chmodImpl);
    return cachedToken.token;
  }

  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const tokenBrokerUrl = validateGitHubTokenBrokerUrl(config.tokenBrokerUrl);
  const response = await fetchImpl(tokenBrokerUrl, {
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

  if (tokenCachePath) {
    await writeSecretFile(
      tokenCachePath,
      JSON.stringify(payload),
      mkdirImpl,
      chmodImpl,
      writeFileImpl
    );
  }

  return payload.token;
}

async function writeSecretFile(
  path: string,
  data: string,
  mkdirImpl: typeof mkdir,
  chmodImpl: typeof chmod,
  writeFileImpl: typeof writeFile
): Promise<void> {
  const parentDir = dirname(path);
  const createdDir = await mkdirImpl(parentDir, {
    recursive: true,
    mode: 0o700,
  });
  if (createdDir !== undefined) {
    await chmodImpl(parentDir, 0o700);
  }
  await chmodExistingSecretFile(path, chmodImpl);
  await writeFileImpl(path, data, { encoding: "utf8", mode: 0o600 });
  await chmodImpl(path, 0o600);
}

async function chmodExistingSecretFile(
  path: string,
  chmodImpl: typeof chmod
): Promise<void> {
  try {
    await chmodImpl(path, 0o600);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return;
    }

    throw error;
  }
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
