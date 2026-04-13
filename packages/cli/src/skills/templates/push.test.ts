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
  contextYamlPath: ".gh-symphony/context.yaml",
  referenceWorkflowPath: ".gh-symphony/reference-workflow.md",
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
  it("mentions git push", () => {
    expect(generatePushSkill(mockCtx)).toContain("git push");
  });
  it("no double-brace vars", () => {
    expect(generatePushSkill(mockCtx)).not.toMatch(/\{\{/);
  });
});
