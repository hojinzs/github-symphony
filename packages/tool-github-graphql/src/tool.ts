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
import { validateGitHubGraphQLApiUrl } from "./url-policy.js";

const DEFAULT_GITHUB_GRAPHQL_API_URL = "https://api.github.com/graphql";

export type GitHubGraphQLInvocation = {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
};

export type GitHubGraphQLToolConfig = {
  token?: string;
  apiUrl?: string;
  rateLimitPolicy?: GitHubGraphQLRateLimitPolicy;
};

/**
 * Host-owned tracker identity supplied by a runtime transport. The provider
 * adapter keeps this context internal; it is never added to GraphQL payloads.
 */
export type TrackerToolExecutionContext = {
  issue: {
    id: string;
    identifier: string;
    nativeRef: unknown;
  };
};

export async function executeGitHubGraphQL(
  invocation: GitHubGraphQLInvocation,
  config: GitHubGraphQLToolConfig,
  fetchImpl: typeof fetch = fetch,
  context?: TrackerToolExecutionContext
): Promise<unknown> {
  assertTrackerToolExecutionContext(context);
  const token = resolveGitHubGraphQLToken(config);
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
        body: JSON.stringify(instrumentedInvocation.invocation),
      });

      const payload = (await response.json()) as GitHubGraphQLPayload;
      const fieldRateLimits = extractGraphQLRateLimitField(
        isRecord(payload.data)
          ? payload.data[instrumentedInvocation.rateLimitResponseKey]
          : null
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

function assertTrackerToolExecutionContext(
  context: TrackerToolExecutionContext | undefined
): void {
  if (
    context &&
    (context.issue.id.trim() === "" || context.issue.identifier.trim() === "")
  ) {
    throw new Error("Tracker tool context must identify the current issue.");
  }
}

type GitHubGraphQLPayload = {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
  [key: string]: unknown;
};

function instrumentGitHubGraphQLInvocation(
  invocation: GitHubGraphQLInvocation
): {
  invocation: GitHubGraphQLInvocation;
  rateLimitResponseKey: string;
} {
  try {
    const document = parse(invocation.query);
    let rateLimitResponseKey: string | null = null;
    const definitions = document.definitions.map((definition) => {
      if (!shouldInstrumentOperation(definition, invocation.operationName)) {
        return definition;
      }

      const existingRateLimit = definition.selectionSet.selections.find(
        (selection) =>
          selection.kind === "Field" && selection.name.value === "rateLimit"
      );
      if (existingRateLimit?.kind === "Field") {
        rateLimitResponseKey = getFieldResponseKey(existingRateLimit);
        return definition;
      }

      const usedResponseKeys = new Set(
        definition.selectionSet.selections
          .filter(
            (selection): selection is FieldNode => selection.kind === "Field"
          )
          .map(getFieldResponseKey)
      );
      const rateLimitAlias = createUniqueRateLimitAlias(usedResponseKeys);
      rateLimitResponseKey = rateLimitAlias;
      return {
        ...definition,
        selectionSet: {
          ...definition.selectionSet,
          selections: [
            ...definition.selectionSet.selections,
            buildRateLimitField(rateLimitAlias),
          ],
        },
      };
    });

    return {
      invocation: {
        ...invocation,
        query: print({ ...document, definitions }),
      },
      rateLimitResponseKey: rateLimitResponseKey ?? "rateLimit",
    };
  } catch {
    // Preserve the server's existing validation and error behavior for invalid
    // or provider-specific GraphQL documents that the local parser rejects.
    return { invocation, rateLimitResponseKey: "rateLimit" };
  }
}

function getFieldResponseKey(field: FieldNode): string {
  return field.alias?.value ?? field.name.value;
}

function createUniqueRateLimitAlias(usedResponseKeys: Set<string>): string {
  const base = "__ghSymphonyRateLimit";
  let alias = base;
  let suffix = 2;
  while (usedResponseKeys.has(alias)) {
    alias = `${base}${suffix}`;
    suffix += 1;
  }
  return alias;
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

function buildRateLimitField(alias: string): FieldNode {
  return {
    kind: Kind.FIELD,
    alias: { kind: Kind.NAME, value: alias },
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

export function resolveGitHubGraphQLToken(
  config: GitHubGraphQLToolConfig
): string {
  const token = config.token?.trim();
  if (!token) {
    throw new Error("GITHUB_GRAPHQL_TOKEN is required.");
  }
  return token;
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
