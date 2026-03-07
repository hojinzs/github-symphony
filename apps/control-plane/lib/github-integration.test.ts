import {
  GitHubBootstrapAttemptStatus,
  GitHubIntegrationStatus
} from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  classifyGitHubIntegration,
  createGitHubBootstrapAttempt,
  fingerprintBootstrapStateToken,
  loadGitHubIntegrationSummary,
  loadReadyGitHubIntegration,
  saveGitHubIntegration
} from "./github-integration";
import { createGitHubSecretProtector } from "./github-integration-secrets";

type IntegrationFixture = Exclude<
  Parameters<typeof classifyGitHubIntegration>[0],
  null
>;

const encryptedClientSecret = createGitHubSecretProtector({
  encryptionKey: Buffer.alloc(32, 1)
}).encrypt("client-secret");
const encryptedPrivateKey = createGitHubSecretProtector({
  encryptionKey: Buffer.alloc(32, 1)
}).encrypt("private-key");

const baseIntegration: IntegrationFixture = {
  id: "integration-1",
  singletonKey: "system",
  status: GitHubIntegrationStatus.pending,
  appId: null,
  clientId: null,
  appSlug: null,
  appName: null,
  encryptedClientSecret: null,
  encryptedPrivateKey: null,
  encryptedWebhookSecret: null,
  installationId: null,
  installationTargetLogin: null,
  installationTargetType: null,
  installationTargetUrl: null,
  degradedReason: null,
  lastValidatedAt: null,
  createdAt: new Date("2026-03-07T10:00:00.000Z"),
  updatedAt: new Date("2026-03-07T10:00:00.000Z"),
  bootstrapAttempts: [] as Array<{
    id: string;
    status: GitHubBootstrapAttemptStatus;
    expiresAt: Date;
    manifestUrl: string | null;
    githubAppName: string | null;
    failureReason: string | null;
    createdAt: Date;
  }>
};

function createDatabase(overrides: {
  integration?: IntegrationFixture | null;
}) {
  const gitHubIntegration = {
    findUnique: vi.fn().mockResolvedValue(overrides.integration ?? null),
    upsert: vi.fn().mockImplementation(async (args) => ({
      id: "integration-1",
      ...args.create
    }))
  };
  const gitHubBootstrapAttempt = {
    create: vi.fn().mockImplementation(async (args) => ({
      id: "attempt-1",
      ...args.data
    })),
    findUnique: vi.fn().mockResolvedValue(null)
  };

  return {
    gitHubIntegration,
    gitHubBootstrapAttempt
  };
}

describe("classifyGitHubIntegration", () => {
  it("returns unconfigured when no singleton record exists", () => {
    expect(classifyGitHubIntegration(null)).toBe("unconfigured");
  });

  it("returns pending when bootstrap is in progress", () => {
    expect(classifyGitHubIntegration(baseIntegration)).toBe("pending");
  });

  it("returns degraded when a ready record is incomplete", () => {
    expect(
      classifyGitHubIntegration({
        ...baseIntegration,
        status: GitHubIntegrationStatus.ready
      })
    ).toBe("degraded");
  });
});

describe("loadGitHubIntegrationSummary", () => {
  it("returns recovery-safe integration metadata", async () => {
    const database = createDatabase({
      integration: {
        ...baseIntegration,
        appName: "GitHub Symphony",
        bootstrapAttempts: [
          {
            id: "attempt-1",
            status: GitHubBootstrapAttemptStatus.pending,
            expiresAt: new Date("2026-03-07T11:00:00.000Z"),
            manifestUrl: "https://github.com/settings/apps/new",
            githubAppName: "GitHub Symphony",
            failureReason: null,
            createdAt: new Date("2026-03-07T10:00:00.000Z")
          }
        ]
      }
    });

    const summary = await loadGitHubIntegrationSummary(
      database as never,
      new Date("2026-03-07T10:30:00.000Z")
    );

    expect(summary.state).toBe("pending");
    expect(summary.integration?.appName).toBe("GitHub Symphony");
    expect(summary.integration?.hasClientSecret).toBe(false);
    expect(summary.latestBootstrapAttempt?.isExpired).toBe(false);
  });
});

describe("loadReadyGitHubIntegration", () => {
  it("decrypts ready GitHub App credentials", async () => {
    const database = createDatabase({
      integration: {
        ...baseIntegration,
        status: GitHubIntegrationStatus.ready,
        appId: "12345",
        clientId: "Iv1.12345",
        encryptedClientSecret,
        encryptedPrivateKey,
        installationId: "67890",
        installationTargetLogin: "acme",
        installationTargetType: "Organization"
      }
    });

    const ready = await loadReadyGitHubIntegration(
      database as never,
      createGitHubSecretProtector({
        encryptionKey: Buffer.alloc(32, 1)
      })
    );

    expect(ready.appId).toBe("12345");
    expect(ready.clientSecret).toBe("client-secret");
    expect(ready.privateKey).toBe("private-key");
  });
});

describe("singleton persistence helpers", () => {
  it("upserts the singleton integration record", async () => {
    const database = createDatabase({
      integration: null
    });

    await saveGitHubIntegration(
      {
        status: GitHubIntegrationStatus.pending,
        appName: "GitHub Symphony"
      },
      database as never
    );

    expect(database.gitHubIntegration.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          singletonKey: "system"
        }
      })
    );
  });

  it("stores bootstrap attempts by hashed state token", async () => {
    const database = createDatabase({
      integration: null
    });

    await createGitHubBootstrapAttempt(
      {
        stateToken: "bootstrap-state",
        manifest: {
          name: "GitHub Symphony"
        },
        expiresAt: new Date("2026-03-07T11:00:00.000Z")
      },
      database as never
    );

    expect(database.gitHubBootstrapAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stateFingerprint: fingerprintBootstrapStateToken("bootstrap-state")
        })
      })
    );
  });
});
