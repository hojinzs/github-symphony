import { describe, expect, it, vi } from "vitest";
import {
  getStaleRepositorySelectionError,
  listGitHubInstallationRepositories,
  resolveGitHubInstallationRepositorySelection
} from "./github-installation-repositories";

describe("listGitHubInstallationRepositories", () => {
  it("lists repositories accessible to the configured PAT", async () => {
    const credentialBroker = vi.fn().mockResolvedValue({
      token: "ghp_machine_user",
      expiresAt: new Date("2026-03-07T11:00:00.000Z"),
      installationId: null,
      ownerLogin: "acme",
      ownerType: "Organization",
      provider: "pat_classic",
      source: "pat",
      actorLogin: "machine-user",
      tokenFingerprint: "pat-fingerprint"
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: 22,
            name: "platform",
            full_name: "acme/platform",
            clone_url: "https://github.com/acme/platform.git",
            owner: {
              login: "acme"
            }
          }
        ]),
        { status: 200 }
      )
    );

    const repositories = await listGitHubInstallationRepositories({
      fetchImpl: fetchImpl as typeof fetch,
      credentialBroker
    });

    expect(repositories).toEqual([
      {
        id: "22",
        owner: "acme",
        name: "platform",
        fullName: "acme/platform",
        cloneUrl: "https://github.com/acme/platform.git"
      }
    ]);
  });
});

describe("resolveGitHubInstallationRepositorySelection", () => {
  it("rejects stale repository selections", async () => {
    const credentialBroker = vi.fn().mockResolvedValue({
      token: "ghp_machine_user",
      expiresAt: new Date("2026-03-07T11:00:00.000Z"),
      installationId: null,
      ownerLogin: "acme",
      ownerType: "Organization",
      provider: "pat_classic",
      source: "pat",
      actorLogin: "machine-user",
      tokenFingerprint: "pat-fingerprint"
    });
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: 22,
            name: "platform",
            full_name: "acme/platform",
            clone_url: "https://github.com/acme/platform.git",
            owner: {
              login: "acme"
            }
          }
        ]),
        { status: 200 }
      )
    );

    await expect(
      resolveGitHubInstallationRepositorySelection(["11"], {
        fetchImpl: fetchImpl as typeof fetch,
        credentialBroker
      })
    ).rejects.toThrow(getStaleRepositorySelectionError());
  });
});
