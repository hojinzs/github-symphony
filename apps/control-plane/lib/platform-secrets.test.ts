import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPlatformSecretProtector,
  loadPlatformSecretProtectorFromEnv,
  PlatformSecretProtectionError
} from "./platform-secrets";

const originalPlatformSecretsKey = process.env.PLATFORM_SECRETS_KEY;
const originalGitHubSecretsKey = process.env.GITHUB_APP_SECRETS_KEY;

beforeEach(() => {
  delete process.env.PLATFORM_SECRETS_KEY;
  delete process.env.GITHUB_APP_SECRETS_KEY;
});

afterEach(() => {
  process.env.PLATFORM_SECRETS_KEY = originalPlatformSecretsKey;
  process.env.GITHUB_APP_SECRETS_KEY = originalGitHubSecretsKey;
});

describe("createPlatformSecretProtector", () => {
  it("encrypts and decrypts platform secret material", () => {
    const protector = createPlatformSecretProtector({
      encryptionKey: Buffer.alloc(32, 5)
    });

    const payload = protector.encrypt("sk-platform-secret");

    expect(payload).not.toContain("sk-platform-secret");
    expect(protector.decrypt(payload)).toBe("sk-platform-secret");
  });

  it("rejects malformed payloads", () => {
    const protector = createPlatformSecretProtector({
      encryptionKey: Buffer.alloc(32, 6)
    });

    expect(() => protector.decrypt("broken-payload")).toThrow(
      PlatformSecretProtectionError
    );
  });
});

describe("loadPlatformSecretProtectorFromEnv", () => {
  it("loads from the dedicated platform secrets key", () => {
    process.env.PLATFORM_SECRETS_KEY = Buffer.alloc(32, 7).toString("base64");

    const protector = loadPlatformSecretProtectorFromEnv();

    expect(protector.decrypt(protector.encrypt("sk-ready"))).toBe("sk-ready");
  });

  it("falls back to the legacy GitHub secrets key", () => {
    process.env.GITHUB_APP_SECRETS_KEY = Buffer.alloc(32, 8).toString("base64");

    const protector = loadPlatformSecretProtectorFromEnv();

    expect(protector.decrypt(protector.encrypt("sk-legacy"))).toBe("sk-legacy");
  });
});
