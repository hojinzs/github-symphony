import { describe, expect, it } from "vitest";
import { buildRepositoryValidationGuidance } from "./repository-guidance.js";

describe("buildRepositoryValidationGuidance", () => {
  it("prefers runnable package-manager commands and retains the raw script as context", () => {
    const guidance = buildRepositoryValidationGuidance({
      packageManager: "pnpm",
      testCommand: "vitest run",
      lintCommand: "eslint src",
      buildCommand: "tsc -b",
      monorepo: false,
    });

    expect(guidance[0]).toContain("test: `pnpm test` (script: `vitest run`)");
    expect(guidance[0]).toContain("lint: `pnpm lint` (script: `eslint src`)");
    expect(guidance[0]).toContain("build: `pnpm build` (script: `tsc -b`)");
  });

  it("normalizes whitespace and renders inline code safely for special characters", () => {
    const guidance = buildRepositoryValidationGuidance({
      packageManager: null,
      testCommand: "node -e \"console.log(`one`)\nconsole.log('two')\"",
      lintCommand: null,
      buildCommand: null,
      monorepo: false,
    });

    expect(guidance[0]).toContain(
      "test: ``node -e \"console.log(`one`) console.log('two')\"``"
    );
    expect(guidance[0]).not.toContain("\nconsole.log");
  });

  it("renders explicit non-Node commands without inventing package-script wrappers", () => {
    const guidance = buildRepositoryValidationGuidance({
      packageManager: "uv",
      testCommand: "uv run pytest",
      lintCommand: "make lint",
      buildCommand: null,
      monorepo: false,
    });

    expect(guidance[0]).toContain("test: `uv run pytest`");
    expect(guidance[0]).toContain("lint: `make lint`");
    expect(guidance[0]).not.toContain("(script:");
    expect(guidance[3]).toContain("Use `uv` conventions");
  });
});
