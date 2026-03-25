import { readFileSync } from "node:fs";
import { defineConfig } from "tsup";

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
  version: string;
};

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "worker-entry": "src/worker-entry.ts",
  },
  format: ["esm"],
  target: "node24",
  outDir: "dist",
  clean: true,
  splitting: true,
  dts: { entry: { index: "src/index.ts" } },
  banner: {
    js: "#!/usr/bin/env node",
  },
  noExternal: [/^@gh-symphony\//],
  define: {
    __CLI_VERSION__: JSON.stringify(pkg.version),
  },
});
