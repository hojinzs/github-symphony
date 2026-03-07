import {
  createPlatformSecretProtector,
  loadPlatformSecretProtectorFromEnv,
  PlatformSecretProtectionError,
  type PlatformSecretProtector
} from "./platform-secrets";

const GITHUB_APP_SECRETS_KEY_ENV = "GITHUB_APP_SECRETS_KEY";

export class GitHubSecretProtectionError extends PlatformSecretProtectionError {}

export type GitHubSecretProtector = {
  encrypt(secret: string): string;
  decrypt(payload: string): string;
  fingerprint(secret: string): string;
};

export function createGitHubSecretProtector(input: {
  encryptionKey: string | Buffer;
}): GitHubSecretProtector {
  return wrapGitHubErrors(createPlatformSecretProtector(input));
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

  return wrapGitHubErrors(
    loadPlatformSecretProtectorFromEnv({
      ...env,
      PLATFORM_SECRETS_KEY: encryptionKey
    })
  );
}

function wrapGitHubErrors(protector: PlatformSecretProtector): GitHubSecretProtector {
  return {
    encrypt(secret: string): string {
      try {
        return protector.encrypt(secret);
      } catch (error) {
        throw coerceGitHubSecretError(error);
      }
    },
    decrypt(payload: string): string {
      try {
        return protector.decrypt(payload);
      } catch (error) {
        throw coerceGitHubSecretError(error);
      }
    },
    fingerprint(secret: string): string {
      try {
        return protector.fingerprint(secret);
      } catch (error) {
        throw coerceGitHubSecretError(error);
      }
    }
  };
}

function coerceGitHubSecretError(error: unknown): GitHubSecretProtectionError {
  if (error instanceof GitHubSecretProtectionError) {
    return error;
  }

  if (error instanceof PlatformSecretProtectionError) {
    return new GitHubSecretProtectionError(
      error.message.replaceAll("Platform secret", "GitHub secret")
    );
  }

  return new GitHubSecretProtectionError("GitHub secret protection failed.");
}
