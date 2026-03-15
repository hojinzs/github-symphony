import { describe, it, expect } from "vitest";
import { generatePullSkill } from "./pull.js";
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
};

describe("generatePullSkill", () => {
  it("returns non-empty string", () => {
    expect(generatePullSkill(mockCtx).length).toBeGreaterThan(50);
  });
  it("contains Rules or Flow section", () => {
    expect(generatePullSkill(mockCtx)).toMatch(/## (Rules|Flow)/);
  });
  it("mentions git fetch or merge", () => {
    expect(generatePullSkill(mockCtx)).toMatch(/git (fetch|merge)/);
  });
  it("no double-brace vars", () => {
    expect(generatePullSkill(mockCtx)).not.toMatch(/\{\{/);
  });
});
