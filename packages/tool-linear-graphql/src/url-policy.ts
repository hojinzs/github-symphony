import { isIP } from "node:net";

const LINEAR_GRAPHQL_HOST = "api.linear.app";
const LINEAR_GRAPHQL_HOST_SUFFIX = ".linear.app";
const BLOCKED_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "169.254.169.254",
]);
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal"];

export function validateLinearGraphQLApiUrl(value: string): string {
  const url = parseUrl(value, "Linear GraphQL API URL");
  const hostname = normalizeHostname(url.hostname);

  if (url.protocol !== "https:") {
    throw new Error("Linear GraphQL API URL must use https.");
  }

  if (!hostname || isBlockedHostname(hostname) || isPrivateIp(hostname)) {
    throw new Error(
      "Linear GraphQL API URL must not target localhost or private networks."
    );
  }

  if (
    hostname !== LINEAR_GRAPHQL_HOST &&
    !hostname.endsWith(LINEAR_GRAPHQL_HOST_SUFFIX)
  ) {
    throw new Error("Linear GraphQL API URL host is not allowlisted.");
  }

  return url.href;
}

function parseUrl(value: string, label: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
}

function normalizeHostname(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "")
    .toLowerCase();
}

function isBlockedHostname(hostname: string): boolean {
  return (
    BLOCKED_HOSTS.has(hostname) ||
    BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
  );
}

function isPrivateIp(hostname: string): boolean {
  const ipVersion = isIP(hostname);

  if (ipVersion === 4) {
    return isPrivateIpv4(hostname);
  }

  if (ipVersion === 6) {
    return isPrivateIpv6(hostname);
  }

  return false;
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".").map((part) => Number(part));

  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return false;
  }

  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  const ipv4MappedPrefix = "::ffff:";

  if (normalized.startsWith(ipv4MappedPrefix)) {
    const mappedIpv4 = parseIpv4MappedIpv6(
      normalized.slice(ipv4MappedPrefix.length)
    );
    return mappedIpv4 ? isPrivateIpv4(mappedIpv4) : true;
  }

  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  );
}

function parseIpv4MappedIpv6(value: string): string | null {
  if (value.includes(".")) {
    return value;
  }

  const parts = value.split(":");
  if (parts.length !== 2) {
    return null;
  }

  const high = Number.parseInt(parts[0] ?? "", 16);
  const low = Number.parseInt(parts[1] ?? "", 16);

  if (
    !Number.isInteger(high) ||
    !Number.isInteger(low) ||
    high < 0 ||
    high > 0xffff ||
    low < 0 ||
    low > 0xffff
  ) {
    return null;
  }

  return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join(
    "."
  );
}
