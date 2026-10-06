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
  const origin = new URL(input.publicOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("Fleet publicOrigin must be an HTTPS origin");
  }
  const bindAddress = input.bindAddress ?? "127.0.0.1";
  if (!bindAddress.trim() || bindAddress !== bindAddress.trim()) {
    throw new Error("Fleet bindAddress must be a non-empty address");
  }
  return {
    dataDir: resolve(input.dataDir),
    publicOrigin: origin.origin,
    bindAddress,
  };
}
