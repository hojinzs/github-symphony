import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes
} from "node:crypto";

const ENCRYPTION_KEY_BYTES = 32;
const IV_BYTES = 12;
const PAYLOAD_VERSION = "v1";

export class PlatformSecretProtectionError extends Error {}

export type PlatformSecretProtector = {
  encrypt(secret: string): string;
  decrypt(payload: string): string;
  fingerprint(secret: string): string;
};

export function createPlatformSecretProtector(input: {
  encryptionKey: string | Buffer;
}): PlatformSecretProtector {
  const key = normalizeEncryptionKey(input.encryptionKey);

  return {
    encrypt(secret: string): string {
      requireNonEmptySecret(secret, "Platform secret values");

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
        throw new PlatformSecretProtectionError(
          "Platform secret payload is malformed."
        );
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

        requireNonEmptySecret(plaintext, "Platform secret values");

        return plaintext;
      } catch (error) {
        throw new PlatformSecretProtectionError(
          error instanceof Error
            ? `Platform secret decryption failed: ${error.message}`
            : "Platform secret decryption failed."
        );
      }
    },
    fingerprint(secret: string): string {
      requireNonEmptySecret(secret, "Platform secret values");
      return createHash("sha256").update(secret).digest("hex");
    }
  };
}

export function loadPlatformSecretProtectorFromEnv(
  env: Record<string, string | undefined> = process.env
): PlatformSecretProtector {
  const encryptionKey = env.PLATFORM_SECRETS_KEY;

  if (!encryptionKey) {
    throw new PlatformSecretProtectionError(
      "PLATFORM_SECRETS_KEY is required to protect stored platform secrets."
    );
  }

  return createPlatformSecretProtector({
    encryptionKey
  });
}

function normalizeEncryptionKey(value: string | Buffer): Buffer {
  if (Buffer.isBuffer(value)) {
    if (value.byteLength !== ENCRYPTION_KEY_BYTES) {
      throw new PlatformSecretProtectionError(
        `Platform secret encryption key must be ${ENCRYPTION_KEY_BYTES} bytes.`
      );
    }

    return value;
  }

  const trimmed = value.trim();
  const encoding = /^[a-f0-9]+$/i.test(trimmed) ? "hex" : "base64";
  const key = Buffer.from(trimmed, encoding);

  if (key.byteLength !== ENCRYPTION_KEY_BYTES) {
    throw new PlatformSecretProtectionError(
      `Platform secret encryption key must decode to ${ENCRYPTION_KEY_BYTES} bytes.`
    );
  }

  return key;
}

function requireNonEmptySecret(secret: string, subject: string): void {
  if (secret.trim().length === 0) {
    throw new PlatformSecretProtectionError(`${subject} must be non-empty.`);
  }
}
