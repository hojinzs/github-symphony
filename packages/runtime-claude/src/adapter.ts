import {
  extractEnvForClaude,
  type AgentRuntimeCredentialBrokerResponse,
  type AgentRuntimeEnv,
} from "@gh-symphony/core";

export function resolveClaudeCredentials(
  brokerResponse: AgentRuntimeCredentialBrokerResponse
): AgentRuntimeEnv {
  return extractEnvForClaude(brokerResponse.env);
}
