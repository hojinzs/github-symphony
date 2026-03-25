import { defineConfig } from "tsup";

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
});
