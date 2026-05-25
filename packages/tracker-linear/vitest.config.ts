import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@gh-symphony/core": resolve(packageRoot, "../core/src/index.ts"),
    },
  },
  test: {
    environment: "node",
  },
});
