import { readFile, writeFile } from "node:fs/promises";
import type {
  AgentRuntimeCredentialBrokerResponse,
  AgentRuntimeEnv,
} from "./adapter.js";

export const TOKEN_REUSE_WINDOW_MS = 60 * 1000;

const CODEX_ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORG_ID",
  "OPENAI_PROJECT",
] as const;

export type AgentRuntimeCredentialCacheEntry =
  AgentRuntimeCredentialBrokerResponse & {
    cachedAt: string;
  };

export class AgentRuntimeCredentialError extends Error {}

type AgentRuntimeEnvSource = Record<string, string | undefined>;

export function extractEnvForCodex(
  env: AgentRuntimeEnvSource
): AgentRuntimeEnv {
  return pickRuntimeEnv(env, CODEX_ENV_KEYS);
}

export function extractEnvForClaude(
  env: AgentRuntimeEnvSource,
  envKey = "ANTHROPIC_API_KEY"
): AgentRuntimeEnv {
  const apiKey = env[envKey];

  if (!apiKey) {
    throw new AgentRuntimeCredentialError(
      `${envKey} is required in the credential broker response.`
    );
  }

  return {
    [envKey]: apiKey,
  };
}

export function toAgentCredentialCacheEntry(
  brokerResponse: AgentRuntimeCredentialBrokerResponse,
  now: Date = new Date()
): AgentRuntimeCredentialCacheEntry {
  return {
    env: brokerResponse.env,
    expires_at: brokerResponse.expires_at,
    cachedAt: now.toISOString(),
  };
}

export function shouldReuseAgentCredentialCache(
  entry: AgentRuntimeCredentialCacheEntry,
  now: Date = new Date()
): boolean {
  if (Object.keys(entry.env).length === 0) {
    return false;
  }

  if (!entry.expires_at) {
    return true;
  }

  const expiresAt = Date.parse(entry.expires_at);
  if (Number.isNaN(expiresAt)) {
    return false;
  }

  return expiresAt - now.getTime() > TOKEN_REUSE_WINDOW_MS;
}

export async function readAgentCredentialCache(
  path: string,
  readFileImpl: typeof readFile = readFile
): Promise<AgentRuntimeCredentialCacheEntry | null> {
  try {
    return normalizeAgentCredentialCacheEntry(
      JSON.parse(await readFileImpl(path, "utf8")) as unknown
    );
  } catch {
    return null;
  }
}

export async function writeAgentCredentialCache(
  path: string,
  brokerResponse: AgentRuntimeCredentialBrokerResponse,
  writeFileImpl: typeof writeFile = writeFile,
  now: Date = new Date()
): Promise<AgentRuntimeCredentialCacheEntry> {
  const entry = toAgentCredentialCacheEntry(brokerResponse, now);
  await writeFileImpl(path, JSON.stringify(entry), "utf8");
  return entry;
}

function pickRuntimeEnv(
  env: AgentRuntimeEnvSource,
  keys: ReadonlyArray<string>
): AgentRuntimeEnv {
  const resolved: AgentRuntimeEnv = {};

  for (const key of keys) {
    const value = env[key];
    if (value) {
      resolved[key] = value;
    }
  }

  return resolved;
}

function normalizeAgentCredentialCacheEntry(
  payload: unknown
): AgentRuntimeCredentialCacheEntry | null {
  if (!isRecord(payload)) {
    return null;
  }

  if (!isRecord(payload.env)) {
    return null;
  }

  const env = Object.fromEntries(
    Object.entries(payload.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );

  if (Object.keys(env).length === 0) {
    return null;
  }

  return {
    env,
    expires_at:
      typeof payload.expires_at === "string" ? payload.expires_at : undefined,
    cachedAt:
      typeof payload.cachedAt === "string"
        ? payload.cachedAt
        : new Date(0).toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
