import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

export default defineConfig({
  resolve: {
    alias: {
      "@gh-symphony/core": resolve(repoRoot, "packages/core/src/index.ts"),
      "@gh-symphony/runtime-claude": resolve(
        repoRoot,
        "packages/runtime-claude/src/index.ts"
      ),
      "@gh-symphony/tool-github-graphql": resolve(
        repoRoot,
        "packages/tool-github-graphql/src/index.ts"
      ),
    },
  },
  test: {
    include: ["test/e2e/claude/*.spec.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
