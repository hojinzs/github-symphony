import {
  createTrackerToolContext,
  executeCodexDynamicToolCall,
} from "/app/packages/worker/dist/codex-dynamic-tools.js";

const env = {
  SYMPHONY_ISSUE_ID: "docker-issue-730",
  SYMPHONY_ISSUE_IDENTIFIER: "test-owner/test-repo#730",
  SYMPHONY_ISSUE_NATIVE_REF: '{"itemId":"docker-item-730"}',
  GITHUB_GRAPHQL_TOKEN: "host-only-test-token",
};
const context = createTrackerToolContext(env);
const response = await executeCodexDynamicToolCall(
  "github_graphql",
  { query: "query { viewer { login } }" },
  context,
  env,
  {
    executeGitHubGraphQL: async (_invocation, _config, receivedContext) => {
      if (JSON.stringify(receivedContext) !== JSON.stringify(context)) {
        throw new Error("issue_context_not_forwarded");
      }
      return { data: { viewer: { login: "docker-host-tool" } } };
    },
  }
);

if (
  response.success !== true ||
  response.contentItems[0]?.text !==
    '{"data":{"viewer":{"login":"docker-host-tool"}}}'
) {
  throw new Error(`unexpected_host_tool_response:${JSON.stringify(response)}`);
}

console.log("host_dynamic_tool_e2e=pass");
