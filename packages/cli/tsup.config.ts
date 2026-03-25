import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node24",
  outDir: "dist",
  clean: true,
  splitting: true,
  dts: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
  noExternal: [/^@gh-symphony\//],
});
