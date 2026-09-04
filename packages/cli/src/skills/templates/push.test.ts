import { describe, it, expect } from "vitest";
import { generatePushSkill } from "./push.js";
import type { SkillTemplateContext } from "../types.js";

const mockCtx: SkillTemplateContext = {
  runtime: "claude-code",
  projectId: "PVT_test",
  githubProjectTitle: "Test",
  repositories: [{ owner: "acme", name: "platform" }],
  statusColumns: [{ id: "opt_todo", name: "Todo", role: "active" }],
  statusFieldId: "PVTF_field",
  detectedEnvironment: {
    packageManager: "pnpm",
    testCommand: "pnpm test",
    lintCommand: "pnpm lint",
    buildCommand: "pnpm build",
    monorepo: false,
  },
};

describe("generatePushSkill", () => {
  it("returns non-empty string", () => {
    expect(generatePushSkill(mockCtx).length).toBeGreaterThan(50);
  });
  it("contains Rules or Flow section", () => {
    expect(generatePushSkill(mockCtx)).toMatch(/## (Rules|Flow)/);
  });
  it("publishes through the authenticated host action", () => {
    const result = generatePushSkill(mockCtx);
    expect(result).toContain("/api/v1/assigned-branch/publish");
    expect(result).toContain("X-Symphony-Run-Id");
    expect(result).toContain("X-Symphony-Orchestrator-Token");
    expect(result).toContain("Never run `git push`");
    expect(result).toContain("A missing remote ref alone is not a blocker");
  });
  it("no double-brace vars", () => {
    expect(generatePushSkill(mockCtx)).not.toMatch(/\{\{/);
  });
});
