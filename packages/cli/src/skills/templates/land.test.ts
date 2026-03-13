import { describe, it, expect } from "vitest";
import { generateLandSkill } from "./land.js";
import type { SkillTemplateContext } from "../types.js";

const mockCtx: SkillTemplateContext = {
  runtime: "claude-code",
  projectId: "PVT_test",
  projectTitle: "Test",
  repositories: [{ owner: "acme", name: "platform" }],
  statusColumns: [{ id: "opt_todo", name: "Todo", role: "active" }],
  statusFieldId: "PVTF_field",
  contextYamlPath: ".gh-symphony/context.yaml",
  referenceWorkflowPath: ".gh-symphony/reference-workflow.md",
};

describe("generateLandSkill", () => {
  it("returns non-empty string", () => {
    expect(generateLandSkill(mockCtx).length).toBeGreaterThan(50);
  });
  it("contains Rules or Flow section", () => {
    expect(generateLandSkill(mockCtx)).toMatch(/## (Rules|Flow)/);
  });
  it("mentions gh pr merge", () => {
    expect(generateLandSkill(mockCtx)).toContain("gh pr merge");
  });
  it("delegates to gh-project skill", () => {
    expect(generateLandSkill(mockCtx)).toContain("gh-project");
  });
  it("no double-brace vars", () => {
    expect(generateLandSkill(mockCtx)).not.toMatch(/\{\{/);
  });
});
