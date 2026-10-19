import { afterEach, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadRunnableFleetConfig } from "./runnable-config.js";

const directories: string[] = [];
function config(source: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fleet-config-")));
  directories.push(dir);
  const file = join(dir, "control-plane.yaml");
  writeFileSync(file, source);
  return { file, dir };
}
afterEach(() => {
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

it("loads YAML with safe backend defaults and an explicit proxy trust boundary", () => {
  const { file } = config(
    "publicOrigin: https://FLEET.lan:443/\ntransport: { mode: trusted-proxy }\n"
  );
  expect(loadRunnableFleetConfig(file)).toEqual({
    dataDir: join(homedir(), ".gh-symphony-control-plane"),
    bindAddress: "127.0.0.1",
    port: 4690,
    publicOrigin: "https://fleet.lan",
    transport: { mode: "trusted-proxy" },
  });
});

it("resolves direct TLS material relative to the configuration file", () => {
  const { file, dir } = config(
    "dataDir: /private/fleet\npublicOrigin: https://fleet.lan:8443\nbindAddress: 192.168.1.4\nport: 8443\ntransport:\n  mode: tls\n  certFile: cert.pem\n  keyFile: key.pem\n  caFile: ca.pem\n"
  );
  expect(loadRunnableFleetConfig(file)).toEqual({
    dataDir: "/private/fleet",
    bindAddress: "192.168.1.4",
    port: 8443,
    publicOrigin: "https://fleet.lan:8443",
    transport: {
      mode: "tls",
      certFile: join(dir, "cert.pem"),
      keyFile: join(dir, "key.pem"),
      caFile: join(dir, "ca.pem"),
    },
  });
});

it("rejects malformed, ambiguous, unknown and unsafe configuration before startup", () => {
  const base = {
    publicOrigin: "https://fleet.lan",
    transport: { mode: "trusted-proxy" },
  };
  const invalid: unknown[] = [
    null,
    [],
    { ...base, unknown: true },
    { ...base, publicOrigin: "http://fleet.lan" },
    { ...base, dataDir: "./data" },
    { ...base, bindAddress: "0.0.0.0" },
    { ...base, bindAddress: "8.8.8.8" },
    { ...base, bindAddress: "localhost" },
    { ...base, bindAddress: "::" },
    { ...base, bindAddress: "::ffff:127.0.0.1" },
    { ...base, bindAddress: "10.1.1.2" },
    { ...base, bindAddress: "fd00::1" },
    ...[null, 0, 65536, 1.5, "4690"].map((port) => ({ ...base, port })),
    { ...base, transport: { mode: "http" } },
    { ...base, transport: { mode: "tls", certFile: "a" } },
    {
      ...base,
      transport: { mode: "tls", certFile: "a", keyFile: "b", extra: true },
    },
    { ...base, transport: { mode: "trusted-proxy", keyFile: "b" } },
  ];
  for (const source of [
    "[",
    "publicOrigin: !unknown https://fleet.lan",
    "publicOrigin: a\npublicOrigin: b",
    ...invalid.map((value) => JSON.stringify(value)),
  ]) {
    const { file } = config(source);
    expect(() => loadRunnableFleetConfig(file), source).toThrow(/Fleet config/);
  }
});

it("accepts supported private TLS binds and loopback proxy IPv6 without TLS fields", () => {
  for (const bindAddress of [
    "10.1.1.2",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "fd00::1",
    "::1",
  ]) {
    const { file } = config(
      JSON.stringify({
        publicOrigin: "https://fleet.lan",
        bindAddress,
        transport: { mode: "tls", certFile: "cert", keyFile: "key" },
      })
    );
    expect(loadRunnableFleetConfig(file).bindAddress).toBe(bindAddress);
    expect(loadRunnableFleetConfig(file).transport).not.toHaveProperty(
      "caFile"
    );
  }
  const { file } = config(
    JSON.stringify({
      publicOrigin: "https://fleet.lan",
      bindAddress: "::1",
      transport: { mode: "trusted-proxy" },
    })
  );
  expect(loadRunnableFleetConfig(file).transport).toEqual({
    mode: "trusted-proxy",
  });
});

it("reports unreadable file paths with startup context", () => {
  const { file, dir } = config("");
  rmSync(file);
  expect(() => loadRunnableFleetConfig(file)).toThrow(
    `Fleet config ${join(dir, "control-plane.yaml")}:`
  );
});
