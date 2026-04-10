import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@gh-symphony/core": resolve(packageRoot, "../core/src/index.ts"),
      "@gh-symphony/extension-github-workflow": resolve(
        packageRoot,
        "../extension-github-workflow/src/index.ts"
      ),
      "@gh-symphony/runtime-codex": resolve(
        packageRoot,
        "../runtime-codex/src/index.ts"
      ),
      "@gh-symphony/tracker-github": resolve(
        packageRoot,
        "../tracker-github/src/index.ts"
      ),
    },
  },
  test: {
    environment: "node",
  },
});
