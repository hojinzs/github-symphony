import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from "node:crypto";

const ENCRYPTION_KEY_BYTES = 32;
const IV_BYTES = 12;
const PAYLOAD_VERSION = "v1";
const GITHUB_APP_SECRETS_KEY_ENV = "GITHUB_APP_SECRETS_KEY";

export class GitHubSecretProtectionError extends Error {}

export type GitHubSecretProtector = {
  encrypt(secret: string): string;
  decrypt(payload: string): string;
  fingerprint(secret: string): string;
};

export function createGitHubSecretProtector(input: {
  encryptionKey: string | Buffer;
}): GitHubSecretProtector {
  const key = normalizeEncryptionKey(input.encryptionKey);

  return {
    encrypt(secret: string): string {
      requireNonEmptySecret(secret);

      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([
        cipher.update(secret, "utf8"),
        cipher.final()
      ]);
      const tag = cipher.getAuthTag();

      return [
        PAYLOAD_VERSION,
        iv.toString("base64url"),
        tag.toString("base64url"),
        ciphertext.toString("base64url")
      ].join(".");
    },
    decrypt(payload: string): string {
      const [version, ivValue, tagValue, ciphertextValue] = payload.split(".");

      if (
        version !== PAYLOAD_VERSION ||
        !ivValue ||
        !tagValue ||
        !ciphertextValue
      ) {
        throw new GitHubSecretProtectionError("GitHub secret payload is malformed.");
      }

      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(ivValue, "base64url")
        );

        decipher.setAuthTag(Buffer.from(tagValue, "base64url"));

        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(ciphertextValue, "base64url")),
          decipher.final()
        ]).toString("utf8");

        requireNonEmptySecret(plaintext);

        return plaintext;
      } catch (error) {
        throw new GitHubSecretProtectionError(
          error instanceof Error
            ? `GitHub secret decryption failed: ${error.message}`
            : "GitHub secret decryption failed."
        );
      }
    },
    fingerprint(secret: string): string {
      requireNonEmptySecret(secret);
      return createHash("sha256").update(secret).digest("hex");
    }
  };
}

export function loadGitHubSecretProtectorFromEnv(
  env: Record<string, string | undefined> = process.env
): GitHubSecretProtector {
  const encryptionKey = env[GITHUB_APP_SECRETS_KEY_ENV];

  if (!encryptionKey) {
    throw new GitHubSecretProtectionError(
      `${GITHUB_APP_SECRETS_KEY_ENV} is required to protect stored GitHub App secrets.`
    );
  }

  return createGitHubSecretProtector({
    encryptionKey
  });
}

function normalizeEncryptionKey(value: string | Buffer): Buffer {
  if (Buffer.isBuffer(value)) {
    if (value.byteLength !== ENCRYPTION_KEY_BYTES) {
      throw new GitHubSecretProtectionError(
        `GitHub secret encryption key must be ${ENCRYPTION_KEY_BYTES} bytes.`
      );
    }

    return value;
  }

  const trimmed = value.trim();
  const encoding = /^[a-f0-9]+$/i.test(trimmed) ? "hex" : "base64";
  const key = Buffer.from(trimmed, encoding);

  if (key.byteLength !== ENCRYPTION_KEY_BYTES) {
    throw new GitHubSecretProtectionError(
      `GitHub secret encryption key must decode to ${ENCRYPTION_KEY_BYTES} bytes.`
    );
  }

  return key;
}

function requireNonEmptySecret(secret: string): void {
  if (secret.trim().length === 0) {
    throw new GitHubSecretProtectionError("GitHub secret values must be non-empty.");
  }
}
