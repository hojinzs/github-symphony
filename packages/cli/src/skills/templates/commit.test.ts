import { describe, it, expect } from "vitest";
import { generateCommitSkill } from "./commit.js";
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

describe("generateCommitSkill", () => {
  it("returns non-empty string", () => {
    expect(generateCommitSkill(mockCtx).length).toBeGreaterThan(50);
  });
  it("contains Rules or Flow section", () => {
    expect(generateCommitSkill(mockCtx)).toMatch(/## (Rules|Flow)/);
  });
  it("mentions conventional commit", () => {
    expect(generateCommitSkill(mockCtx).toLowerCase()).toContain(
      "conventional"
    );
  });
  it("no double-brace vars", () => {
    expect(generateCommitSkill(mockCtx)).not.toMatch(/\{\{/);
  });
});
