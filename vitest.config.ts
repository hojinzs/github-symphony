import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const repositoryRoot = dirname(fileURLToPath(import.meta.url));
const isRepositoryRun = resolve(process.cwd()) === repositoryRoot;

export default defineConfig({
  define: {
    __CLI_VERSION__: JSON.stringify("0.0.0-test"),
  },
  test: {
    ...(isRepositoryRun
      ? {
          // Load every package as a Vitest project so aggregate coverage uses
          // the same roots, aliases, setup, and defines as tests. Vitest treats
          // fileParallelism as a root scheduling option in projects mode, so
          // preserve the orchestrator package's serialization requirement here.
          projects: ["packages/*"],
          fileParallelism: false,
          coverage: {
            reportsDirectory: "coverage",
          },
        }
      : {
          include: ["**/*.test.ts"],
          exclude: [...configDefaults.exclude, ".runtime/**"],
          environment: "node",
        }),
  },
});
