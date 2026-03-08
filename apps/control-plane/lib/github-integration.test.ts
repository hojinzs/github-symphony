import { GitHubIntegrationStatus } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  classifyGitHubIntegration,
  loadConfiguredGitHubPatCredentials,
  loadGitHubIntegrationSummary,
  saveGitHubIntegration
} from "./github-integration";
import { createGitHubSecretProtector } from "./github-integration-secrets";

const secretProtector = createGitHubSecretProtector({
  encryptionKey: Buffer.alloc(32, 1)
});

const encryptedPatToken = secretProtector.encrypt("ghp_machine_user");

function createDatabase(integration: Record<string, unknown> | null) {
  return {
    gitHubIntegration: {
      findUnique: vi.fn().mockResolvedValue(integration),
      upsert: vi.fn().mockImplementation(async (args) => ({
        id: "integration-1",
        ...args.create
      }))
    }
  };
}

describe("classifyGitHubIntegration", () => {
  it("returns unconfigured when no singleton record exists", () => {
    expect(classifyGitHubIntegration(null)).toBe("unconfigured");
  });

  it("returns degraded when a ready PAT record is incomplete", () => {
    expect(
      classifyGitHubIntegration({
        id: "integration-1",
        singletonKey: "system",
        status: GitHubIntegrationStatus.ready,
        encryptedPatToken: encryptedPatToken,
        patTokenFingerprint: null,
        patActorId: "100",
        patActorLogin: "machine-user",
        patValidatedOwnerId: "200",
        patValidatedOwnerLogin: "acme",
        patValidatedOwnerType: "Organization",
        patValidatedOwnerUrl: "https://github.com/acme",
        lastValidatedAt: null,
        degradedReason: null,
        createdAt: new Date("2026-03-07T10:00:00.000Z"),
        updatedAt: new Date("2026-03-07T10:00:00.000Z")
      } as never)
    ).toBe("degraded");
  });
});

describe("loadGitHubIntegrationSummary", () => {
  it("surfaces PAT metadata without exposing the token", async () => {
    const database = createDatabase({
      id: "integration-1",
      singletonKey: "system",
      status: GitHubIntegrationStatus.ready,
      encryptedPatToken,
      patTokenFingerprint: "pat-fingerprint",
      patActorId: "100",
      patActorLogin: "machine-user",
      patValidatedOwnerId: "200",
      patValidatedOwnerLogin: "acme",
      patValidatedOwnerType: "Organization",
      patValidatedOwnerUrl: "https://github.com/acme",
      degradedReason: null,
      lastValidatedAt: new Date("2026-03-07T10:00:00.000Z"),
      createdAt: new Date("2026-03-07T10:00:00.000Z"),
      updatedAt: new Date("2026-03-07T10:00:00.000Z")
    });

    const summary = await loadGitHubIntegrationSummary(database as never);

    expect(summary.state).toBe("ready");
    expect(summary.integration?.patActorLogin).toBe("machine-user");
    expect(summary.integration?.patValidatedOwnerLogin).toBe("acme");
    expect(summary.integration?.hasPatToken).toBe(true);
    expect(summary.missingFields).toEqual([]);
  });
});

describe("loadConfiguredGitHubPatCredentials", () => {
  it("decrypts a configured PAT-backed integration", async () => {
    const database = createDatabase({
      id: "integration-1",
      singletonKey: "system",
      status: GitHubIntegrationStatus.ready,
      encryptedPatToken,
      patTokenFingerprint: "pat-fingerprint",
      patActorId: "100",
      patActorLogin: "machine-user",
      patValidatedOwnerId: "200",
      patValidatedOwnerLogin: "acme",
      patValidatedOwnerType: "Organization",
      patValidatedOwnerUrl: "https://github.com/acme",
      degradedReason: null,
      lastValidatedAt: new Date("2026-03-07T10:00:00.000Z"),
      createdAt: new Date("2026-03-07T10:00:00.000Z"),
      updatedAt: new Date("2026-03-07T10:00:00.000Z")
    });

    const configured = await loadConfiguredGitHubPatCredentials(
      database as never,
      secretProtector
    );

    expect(configured.token).toBe("ghp_machine_user");
    expect(configured.actorLogin).toBe("machine-user");
    expect(configured.validatedOwnerLogin).toBe("acme");
  });
});

describe("saveGitHubIntegration", () => {
  it("upserts the singleton integration record", async () => {
    const database = createDatabase(null);

    await saveGitHubIntegration(
      {
        status: GitHubIntegrationStatus.pending,
        degradedReason: null
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
});
