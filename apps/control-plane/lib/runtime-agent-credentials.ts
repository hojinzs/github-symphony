import { db } from "./db";
import {
  issueWorkspaceAgentRuntimeCredentials,
  markWorkspaceRuntimeDegradedForAgentCredential
} from "./agent-credentials";
import { buildWorkspaceRuntimeBrokerUrl } from "./runtime-broker-auth";

export function buildWorkspaceAgentCredentialBrokerUrl(
  workspaceId: string,
  env: Record<string, string | undefined> = process.env
): string {
  return buildWorkspaceRuntimeBrokerUrl(workspaceId, "agent-credentials", env);
}

export async function issueWorkspaceAgentCredentials(
  workspaceId: string,
  dependencies: {
    db?: Pick<typeof db, "workspace" | "agentCredential" | "platformAgentCredentialConfig" | "symphonyInstance">;
  } = {}
) {
  try {
    return await issueWorkspaceAgentRuntimeCredentials(workspaceId, {
      db: dependencies.db
    });
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "Agent credential resolution failed.";

    await markWorkspaceRuntimeDegradedForAgentCredential(
      {
        workspaceId,
        reason
      },
      (dependencies.db ?? db) as Pick<
        typeof db,
        "agentCredential" | "platformAgentCredentialConfig" | "workspace" | "symphonyInstance"
      >
    );

    throw error;
  }
}
