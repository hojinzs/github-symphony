import { describe, expect, it } from "vitest";
import {
  buildWorkspaceRuntimeTokenBrokerUrl,
  deriveWorkspaceRuntimeAuthSecret,
  issueWorkspaceRuntimeCredentials,
  verifyWorkspaceRuntimeAuthSecret
} from "./runtime-github-credentials";

describe("deriveWorkspaceRuntimeAuthSecret", () => {
  it("derives a deterministic workspace-scoped secret", () => {
    const first = deriveWorkspaceRuntimeAuthSecret("workspace-1", {
      WORKSPACE_RUNTIME_AUTH_SECRET: "runtime-secret"
    });
    const second = deriveWorkspaceRuntimeAuthSecret("workspace-1", {
      WORKSPACE_RUNTIME_AUTH_SECRET: "runtime-secret"
    });

    expect(first).toBe(second);
    expect(first).not.toBe(
      deriveWorkspaceRuntimeAuthSecret("workspace-2", {
        WORKSPACE_RUNTIME_AUTH_SECRET: "runtime-secret"
      })
    );
  });
});

describe("verifyWorkspaceRuntimeAuthSecret", () => {
  it("accepts the expected derived secret", () => {
    const secret = deriveWorkspaceRuntimeAuthSecret("workspace-1", {
      WORKSPACE_RUNTIME_AUTH_SECRET: "runtime-secret"
    });

    expect(
      verifyWorkspaceRuntimeAuthSecret("workspace-1", secret, {
        WORKSPACE_RUNTIME_AUTH_SECRET: "runtime-secret"
      })
    ).toBe(true);
    expect(
      verifyWorkspaceRuntimeAuthSecret("workspace-1", "wrong-secret", {
        WORKSPACE_RUNTIME_AUTH_SECRET: "runtime-secret"
      })
    ).toBe(false);
  });
});

describe("buildWorkspaceRuntimeTokenBrokerUrl", () => {
  it("prefers the runtime URL when configured", () => {
    expect(
      buildWorkspaceRuntimeTokenBrokerUrl("workspace-1", {
        CONTROL_PLANE_RUNTIME_URL: "https://runtime.example.com/"
      })
    ).toBe(
      "https://runtime.example.com/api/workspaces/workspace-1/runtime-credentials"
    );
  });
});

describe("issueWorkspaceRuntimeCredentials", () => {
  it("returns short-lived credentials for GraphQL, git push, and PR creation", async () => {
    const credentials = await issueWorkspaceRuntimeCredentials("workspace-1", {
      db: {
        workspace: {
          findUnique: async () => ({
            id: "workspace-1",
            githubProjectId: "project-1"
          })
        }
      } as never,
      credentialBroker: async () => ({
        token: "ghp_runtime",
        expiresAt: new Date("2026-03-07T11:00:00.000Z"),
        installationId: null,
        ownerLogin: "acme",
        ownerType: "Organization",
        provider: "pat_classic",
        source: "pat",
        actorLogin: "machine-user",
        tokenFingerprint: "pat-fingerprint"
      })
    });

    expect(credentials.token).toBe("ghp_runtime");
    expect(credentials.githubProjectId).toBe("project-1");
    expect(credentials.gitHostname).toBe("github.com");
    expect(credentials.gitUsername).toBe("x-access-token");
    expect(credentials.supports).toEqual({
      githubGraphql: true,
      gitPush: true,
      pullRequests: true
    });
  });
});
