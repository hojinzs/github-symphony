import { parse } from "graphql";
import { validateLinearGraphQLApiUrl } from "./url-policy.js";

export const DEFAULT_LINEAR_GRAPHQL_API_URL = "https://api.linear.app/graphql";

export type LinearGraphQLInvocation = {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
};

export type LinearGraphQLToolConfig = {
  apiKey?: string;
  apiUrl?: string;
  authorizationHeader?: string;
};

/** Host-owned tracker identity supplied by a runtime transport. */
export type TrackerToolExecutionContext = {
  issue: {
    id: string;
    identifier: string;
    nativeRef: unknown;
  };
};

export async function executeLinearGraphQL(
  invocation: LinearGraphQLInvocation,
  config: LinearGraphQLToolConfig,
  fetchImpl: typeof fetch = fetch,
  context?: TrackerToolExecutionContext
): Promise<unknown> {
  assertTrackerToolExecutionContext(context);
  validateLinearGraphQLInvocation(invocation);
  const authorization = resolveLinearAuthorizationHeader(config);
  const apiUrl = validateLinearGraphQLApiUrl(
    config.apiUrl ?? DEFAULT_LINEAR_GRAPHQL_API_URL
  );
  const response = await fetchImpl(apiUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization,
    },
    body: JSON.stringify(invocation),
  });

  const payload = (await response.json()) as {
    errors?: Array<{ message: string }>;
  };

  if (!response.ok) {
    throw new Error(
      `Linear GraphQL request failed with status ${response.status}: ${JSON.stringify(payload)}`
    );
  }

  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }

  return payload;
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

export function validateLinearGraphQLInvocation(
  invocation: LinearGraphQLInvocation
): void {
  if (typeof invocation.query !== "string" || invocation.query.trim() === "") {
    throw new Error(
      "linear_graphql requires a non-empty GraphQL query string."
    );
  }

  const document = parse(invocation.query);
  const operationCount = document.definitions.filter(
    (definition) => definition.kind === "OperationDefinition"
  ).length;

  if (operationCount !== 1) {
    throw new Error(
      "linear_graphql accepts exactly one GraphQL operation per request; split multi-operation documents before calling Linear."
    );
  }
}

export function resolveLinearAuthorizationHeader(
  config: LinearGraphQLToolConfig
): string {
  const authorizationHeader = config.authorizationHeader?.trim();
  if (authorizationHeader) {
    return authorizationHeader;
  }

  const apiKey = config.apiKey?.trim();
  if (apiKey) {
    return apiKey;
  }

  throw new Error(
    "Linear GraphQL auth is not configured; provide runtime LINEAR_AUTHORIZATION or LINEAR_API_KEY."
  );
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
  const invocation = JSON.parse(rawInput) as LinearGraphQLInvocation;

  const result = await executeLinearGraphQL(invocation, {
    apiKey: process.env.LINEAR_API_KEY,
    apiUrl: process.env.LINEAR_GRAPHQL_URL,
    authorizationHeader: process.env.LINEAR_AUTHORIZATION,
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
