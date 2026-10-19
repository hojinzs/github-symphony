import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { resolveFleetConfig, type FleetConfig } from "./config.js";

export interface RunnableFleetConfig extends FleetConfig {
  port: number;
  transport:
    | { mode: "tls"; certFile: string; keyFile: string; caFile?: string }
    | { mode: "trusted-proxy" };
}

function object(value: unknown, fields: string[], name: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a mapping`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!fields.includes(key)) throw new Error(`Unknown ${name} field: ${key}`);
  }
  return record;
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim()) {
    throw new Error(
      `${name} must be a non-empty string without surrounding spaces`
    );
  }
  return value;
}

function privateAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number);
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168)
    );
  }
  return (
    isIP(address) === 6 &&
    (address === "::1" || /^(fc|fd)[0-9a-f]{2}:/i.test(address))
  );
}

/** A separate management-plane file; never parsed as workflow configuration. */
export function loadRunnableFleetConfig(file: string): RunnableFleetConfig {
  const path = resolve(file);
  try {
    const document = parseDocument(readFileSync(path, "utf8"), {
      uniqueKeys: true,
    });
    if (document.errors.length || document.warnings.length)
      throw new Error("Invalid YAML (duplicate keys or malformed document)");
    const input = object(
      document.toJS({ maxAliasCount: 0 }),
      ["dataDir", "publicOrigin", "bindAddress", "port", "transport"],
      "fleet config"
    );
    const base = resolveFleetConfig({
      dataDir:
        input.dataDir === undefined
          ? join(homedir(), ".gh-symphony-control-plane")
          : text(input.dataDir, "dataDir"),
      publicOrigin: text(input.publicOrigin, "publicOrigin"),
      bindAddress:
        input.bindAddress === undefined
          ? "127.0.0.1"
          : text(input.bindAddress, "bindAddress"),
    });
    if (!privateAddress(base.bindAddress))
      throw new Error(
        "bindAddress must be a literal loopback or private IP address (no wildcard/public bind)"
      );
    const port = input.port === undefined ? 4690 : input.port;
    if (
      typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    ) {
      throw new Error("port must be an integer from 1 to 65535");
    }
    const transport = object(
      input.transport,
      ["mode", "certFile", "keyFile", "caFile"],
      "transport"
    );
    if (transport.mode === "trusted-proxy") {
      if (base.bindAddress !== "127.0.0.1" && base.bindAddress !== "::1")
        throw new Error("trusted-proxy requires a loopback bindAddress");
      if (Object.keys(transport).some((key) => key !== "mode"))
        throw new Error("trusted-proxy does not accept TLS file fields");
      return { ...base, port, transport: { mode: "trusted-proxy" } };
    }
    if (transport.mode !== "tls")
      throw new Error("transport.mode must be tls or trusted-proxy");
    const filePath = (value: unknown, name: string) =>
      resolve(dirname(path), text(value, name));
    return {
      ...base,
      port,
      transport: {
        mode: "tls",
        certFile: filePath(transport.certFile, "transport.certFile"),
        keyFile: filePath(transport.keyFile, "transport.keyFile"),
        ...(transport.caFile === undefined
          ? {}
          : { caFile: filePath(transport.caFile, "transport.caFile") }),
      },
    };
  } catch (error) {
    // Do not echo source text: configuration may contain sensitive paths/material.
    throw new Error(
      `Fleet config ${path}: ${error instanceof Error ? error.message : "invalid configuration"}`,
      { cause: error }
    );
  }
}
