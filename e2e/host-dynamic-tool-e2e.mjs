import {
  createTrackerToolContext,
  executeCodexDynamicToolCall,
} from "/app/packages/worker/dist/codex-dynamic-tools.js";

const env = {
  SYMPHONY_ISSUE_ID: "docker-issue-730",
  SYMPHONY_ISSUE_IDENTIFIER: "test-owner/test-repo#730",
  SYMPHONY_ISSUE_NATIVE_REF: '{"itemId":"docker-item-730"}',
  GITHUB_GRAPHQL_TOKEN: "host-only-test-token",
  GITHUB_GRAPHQL_API_URL: "https://api.github.com/graphql",
};
const context = createTrackerToolContext(env);
const originalFetch = globalThis.fetch;
let request;
globalThis.fetch = async (url, init) => {
  request = { url: String(url), init };
  return new Response(
    JSON.stringify({ data: { viewer: { login: "docker-host-tool" } } }),
    { status: 200 }
  );
};
let response;
try {
  response = await executeCodexDynamicToolCall(
    "github_graphql",
    { query: "query { viewer { login } }" },
    context,
    env
  );
} finally {
  globalThis.fetch = originalFetch;
}

if (
  response.success !== true ||
  response.contentItems[0]?.text !==
    '{"data":{"viewer":{"login":"docker-host-tool"}}}'
) {
  throw new Error(`unexpected_host_tool_response:${JSON.stringify(response)}`);
}

if (
  request?.url !== "https://api.github.com/graphql" ||
  request?.init?.headers?.authorization !== "Bearer host-only-test-token" ||
  !request?.init?.body?.includes("viewer")
) {
  throw new Error(`unexpected_host_provider_request:${JSON.stringify(request)}`);
}

console.log("host_dynamic_tool_e2e=pass");
