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
const requests = [];
globalThis.fetch = async (url, init) => {
  requests.push({ url: String(url), init });
  const body = String(init?.body);
  return new Response(
    JSON.stringify(
      body.includes("addComment")
        ? {
            data: {
              addComment: { commentEdge: { node: { id: "comment-730" } } },
            },
          }
        : body.includes("updateProjectV2ItemFieldValue")
          ? {
              data: {
                updateProjectV2ItemFieldValue: {
                  projectV2Item: { id: "docker-item-730" },
                },
              },
            }
          : { data: { node: { id: "docker-issue-730" } } }
    ),
    { status: 200 }
  );
};
let responses;
try {
  responses = await Promise.all([
    executeCodexDynamicToolCall(
      "github_graphql",
      {
        query: "query ActiveIssue($id: ID!) { node(id: $id) { id } }",
        variables: { id: "docker-issue-730" },
      },
      context,
      env
    ),
    executeCodexDynamicToolCall(
      "github_graphql",
      {
        query:
          "mutation AddComment($subjectId: ID!, $body: String!) { addComment(input: { subjectId: $subjectId, body: $body }) { commentEdge { node { id } } } }",
        variables: { subjectId: "docker-issue-730", body: "host-side comment" },
      },
      context,
      env
    ),
    executeCodexDynamicToolCall(
      "github_graphql",
      {
        query:
          "mutation UpdateState($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) { updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value }) { projectV2Item { id } } }",
        variables: {
          projectId: "project-730",
          itemId: "docker-item-730",
          fieldId: "status-730",
          value: { singleSelectOptionId: "in-review" },
        },
      },
      context,
      env
    ),
  ]);
} finally {
  globalThis.fetch = originalFetch;
}

if (
  responses.some((response) => response.success !== true) ||
  responses[0]?.contentItems[0]?.text !==
    '{"data":{"node":{"id":"docker-issue-730"}}}'
) {
  throw new Error(`unexpected_host_tool_response:${JSON.stringify(responses)}`);
}

if (
  requests.length !== 3 ||
  requests.some(
    (request) =>
      request.url !== "https://api.github.com/graphql" ||
      request.init?.headers?.authorization !== "Bearer host-only-test-token"
  ) ||
  !requests[0]?.init?.body?.includes("docker-issue-730") ||
  !requests[1]?.init?.body?.includes("addComment") ||
  !requests[1]?.init?.body?.includes("docker-issue-730") ||
  !requests[2]?.init?.body?.includes("updateProjectV2ItemFieldValue") ||
  !requests[2]?.init?.body?.includes("docker-item-730")
) {
  throw new Error(
    `unexpected_host_provider_request:${JSON.stringify(requests)}`
  );
}

console.log("host_dynamic_tool_e2e=pass");
