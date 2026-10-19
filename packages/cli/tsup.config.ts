import { readFileSync, cpSync, mkdirSync, copyFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  version: string;
};

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "agent-entry": "src/agent-entry.ts",
    "management-local": "src/management-local.ts",
    "management-agent": "src/management-agent.ts",
    "worker-entry": "src/worker-entry.ts",
    "mcp-server": "src/mcp-server.ts",
    "git-credential-helper": "src/git-credential-helper.ts",
  },
  format: ["esm"],
  target: "node24",
  // sqlite is a prefix-only Node builtin, not the npm sqlite package.
  removeNodeProtocol: false,
  outDir: "dist",
  clean: true,
  splitting: true,
  dts: {
    entry: {
      index: "src/index.ts",
      "management-local": "src/management-local.ts",
      "management-agent": "src/management-agent.ts",
    },
  },
  banner: {
    js: "#!/usr/bin/env node",
  },
  noExternal: [/^@gh-symphony\//],
  async onSuccess() {
    cpSync("../fleet-control-plane/assets", "assets", { recursive: true });
    mkdirSync("dist/browser", { recursive: true });
    copyFileSync(
      "../fleet-control-plane/dist/browser/run-log-client.js",
      "dist/browser/run-log-client.js"
    );
  },
  define: {
    __CLI_VERSION__: JSON.stringify(pkg.version),
  },
});
