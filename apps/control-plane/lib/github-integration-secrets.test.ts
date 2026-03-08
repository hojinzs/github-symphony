import { describe, expect, it } from "vitest";
import {
  createGitHubSecretProtector,
  GitHubSecretProtectionError,
  loadGitHubSecretProtectorFromEnv
} from "./github-integration-secrets";

describe("createGitHubSecretProtector", () => {
  it("encrypts and decrypts GitHub PAT secret material", () => {
    const protector = createGitHubSecretProtector({
      encryptionKey: Buffer.alloc(32, 7)
    });

    const payload = protector.encrypt("client-secret-value");

    expect(payload).not.toContain("client-secret-value");
    expect(protector.decrypt(payload)).toBe("client-secret-value");
  });

  it("rejects malformed payloads", () => {
    const protector = createGitHubSecretProtector({
      encryptionKey: Buffer.alloc(32, 9)
    });

    expect(() => protector.decrypt("broken-payload")).toThrow(
      GitHubSecretProtectionError
    );
  });
});

describe("loadGitHubSecretProtectorFromEnv", () => {
  it("loads from the platform secrets key", () => {
    const protector = loadGitHubSecretProtectorFromEnv({
      PLATFORM_SECRETS_KEY: Buffer.alloc(32, 4).toString("base64")
    });

    const payload = protector.encrypt("private-key-material");

    expect(protector.decrypt(payload)).toBe("private-key-material");
  });

  it("requires the platform secrets key for GitHub secret protection", () => {
    const protector = loadGitHubSecretProtectorFromEnv({
      PLATFORM_SECRETS_KEY: Buffer.alloc(32, 3).toString("base64")
    });

    const payload = protector.encrypt("private-key-material");

    expect(protector.decrypt(payload)).toBe("private-key-material");
  });

  it("fails when the encryption key is missing", () => {
    expect(() => loadGitHubSecretProtectorFromEnv({})).toThrow(
      "PLATFORM_SECRETS_KEY is required to protect stored GitHub credentials."
    );
  });
});
