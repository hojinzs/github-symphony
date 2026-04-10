import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  define: {
    __CLI_VERSION__: JSON.stringify("0.0.20"),
  },
  resolve: {
    alias: {
      "@gh-symphony/core": resolve(packageRoot, "../core/src/index.ts"),
      "@gh-symphony/dashboard": resolve(packageRoot, "../dashboard/src/index.ts"),
      "@gh-symphony/extension-github-workflow": resolve(
        packageRoot,
        "../extension-github-workflow/src/index.ts"
      ),
      "@gh-symphony/orchestrator": resolve(
        packageRoot,
        "../orchestrator/src/index.ts"
      ),
      "@gh-symphony/runtime-codex": resolve(
        packageRoot,
        "../runtime-codex/src/index.ts"
      ),
      "@gh-symphony/tracker-file": resolve(
        packageRoot,
        "../tracker-file/src/index.ts"
      ),
      "@gh-symphony/tracker-github": resolve(
        packageRoot,
        "../tracker-github/src/index.ts"
      ),
      "@gh-symphony/worker": resolve(packageRoot, "../worker/src/index.ts"),
    },
  },
  test: {
    environment: "node",
  },
});
