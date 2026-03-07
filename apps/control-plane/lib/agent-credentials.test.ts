import {
  AgentCredentialProvider,
  AgentCredentialStatus,
  WorkspaceAgentCredentialSource,
  WorkspaceStatus
} from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAgentCredential,
  ensureWorkspaceHasUsableAgentCredential,
  issueWorkspaceAgentRuntimeCredentials,
  markAgentCredentialDegraded,
  readWorkspaceAgentCredentialStatus,
  setPlatformDefaultAgentCredential
} from "./agent-credentials";
import { createMemoryDatabase } from "./test-harness";

const originalPlatformSecretsKey = process.env.PLATFORM_SECRETS_KEY;

beforeEach(() => {
  process.env.PLATFORM_SECRETS_KEY = Buffer.alloc(32, 9).toString("base64");
});

afterEach(() => {
  process.env.PLATFORM_SECRETS_KEY = originalPlatformSecretsKey;
});

describe("agent credentials", () => {
  it("creates, validates, and resolves the platform default credential for runtime use", async () => {
    const { db } = createMemoryDatabase();
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 })
    );

    const credential = await createAgentCredential(
      {
        label: "Platform default",
        apiKey: "sk-platform-ready-key",
        provider: AgentCredentialProvider.openai
      },
      {
        db,
        fetchImpl: fetchImpl as typeof fetch
      }
    );

    await setPlatformDefaultAgentCredential(credential.id, db);

    const workspace = await db.workspace.create({
      data: {
        slug: "platform",
        name: "Platform",
        promptGuidelines: "Prefer small changes",
        status: WorkspaceStatus.draft,
        githubOwnerLogin: "acme",
        agentCredentialSource: WorkspaceAgentCredentialSource.platform_default,
        repositories: {
          create: [
            {
              owner: "acme",
              name: "platform",
              cloneUrl: "https://github.com/acme/platform.git"
            }
          ]
        }
      }
    });

    const runtimeCredentials = await issueWorkspaceAgentRuntimeCredentials(workspace.id, {
      db
    });
    const status = await readWorkspaceAgentCredentialStatus(workspace.id, db);

    expect(runtimeCredentials.env.OPENAI_API_KEY).toBe("sk-platform-ready-key");
    expect(status).toMatchObject({
      source: WorkspaceAgentCredentialSource.platform_default,
      status: "ready",
      label: "Platform default"
    });
  });

  it("blocks workspace creation when no ready platform default exists", async () => {
    const { db } = createMemoryDatabase();

    await expect(
      ensureWorkspaceHasUsableAgentCredential(
        {
          agentCredentialSource: WorkspaceAgentCredentialSource.platform_default
        },
        db
      )
    ).rejects.toThrow("A ready platform-default agent credential is required");
  });

  it("surfaces degraded workspace override credentials", async () => {
    const { db } = createMemoryDatabase();
    const credential = await db.agentCredential.create({
      data: {
        label: "Workspace override",
        provider: AgentCredentialProvider.openai,
        encryptedSecret: "encrypted-override-secret",
        secretFingerprint: "fingerprint-override",
        status: AgentCredentialStatus.ready,
        lastValidatedAt: new Date("2026-03-07T08:30:00.000Z"),
        degradedReason: null
      }
    });
    await markAgentCredentialDegraded(
      {
        credentialId: credential.id,
        reason: "The provider rejected the rotated secret."
      },
      db
    );
    const workspace = await db.workspace.create({
      data: {
        slug: "override-workspace",
        name: "Override Workspace",
        promptGuidelines: "Prefer small changes",
        status: WorkspaceStatus.draft,
        githubOwnerLogin: "acme",
        agentCredentialSource: WorkspaceAgentCredentialSource.workspace_override,
        agentCredential: {
          connect: {
            id: credential.id
          }
        },
        repositories: {
          create: [
            {
              owner: "acme",
              name: "platform",
              cloneUrl: "https://github.com/acme/platform.git"
            }
          ]
        }
      }
    });

    const status = await readWorkspaceAgentCredentialStatus(workspace.id, db);

    expect(status).toMatchObject({
      source: WorkspaceAgentCredentialSource.workspace_override,
      status: "degraded",
      label: "Workspace override",
      message: "The provider rejected the rotated secret."
    });
  });
});
