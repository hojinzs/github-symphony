import { isAbsolute, resolve } from "node:path";

export interface FleetConfigInput {
  dataDir: string;
  publicOrigin: string;
  bindAddress?: string;
}
export interface FleetConfig {
  dataDir: string;
  publicOrigin: string;
  bindAddress: string;
}

/** Configuration for the fleet service only, never the per-project web server. */
export function resolveFleetConfig(input: FleetConfigInput): FleetConfig {
  if (!isAbsolute(input.dataDir)) {
    throw new Error("Fleet dataDir must be an absolute user-owned directory");
  }
  const bindAddress = input.bindAddress ?? "127.0.0.1";
  if (!bindAddress.trim() || bindAddress !== bindAddress.trim()) {
    throw new Error("Fleet bindAddress must be a non-empty address");
  }
  return {
    dataDir: resolve(input.dataDir),
    publicOrigin: resolveHttpsOrigin(input.publicOrigin),
    bindAddress,
  };
}

/** Shared by service configuration and the browser boundary. */
export function resolveHttpsOrigin(publicOrigin: string): string {
  const origin = new URL(publicOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    !/^https:\/\/[^/?#\\\s]+\/?$/i.test(publicOrigin)
  ) {
    throw new Error("Fleet publicOrigin must be an HTTPS origin");
  }
  return origin.origin;
}
