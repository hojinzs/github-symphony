import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  define: {
    __CLI_VERSION__: JSON.stringify("0.0.0-test"),
  },
  test: {
    include: ["**/*.test.ts"],
    exclude: [...configDefaults.exclude, ".runtime/**"],
    environment: "node",
  },
});
