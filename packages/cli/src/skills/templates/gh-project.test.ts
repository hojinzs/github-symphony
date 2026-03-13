import { describe, it, expect } from "vitest";
import { generateGhProjectSkill } from "./gh-project.js";
import type { SkillTemplateContext } from "../types.js";

const mockCtx: SkillTemplateContext = {
  runtime: "claude-code",
  projectId: "PVT_test123",
  projectTitle: "Test Project",
  repositories: [{ owner: "acme", name: "platform" }],
  statusColumns: [
    { id: "opt_todo", name: "Todo", role: "active" },
    { id: "opt_review", name: "Review", role: "wait" },
    { id: "opt_done", name: "Done", role: "terminal" },
  ],
  statusFieldId: "PVTF_field123",
  contextYamlPath: ".gh-symphony/context.yaml",
  referenceWorkflowPath: ".gh-symphony/reference-workflow.md",
};

describe("generateGhProjectSkill", () => {
  it("returns a non-empty string", () => {
    const result = generateGhProjectSkill(mockCtx);
    expect(result.length).toBeGreaterThan(100);
  });

  it("contains gh project item-edit command", () => {
    const result = generateGhProjectSkill(mockCtx);
    expect(result).toContain("gh project item-edit");
  });

  it("contains Column ID Quick Reference table", () => {
    const result = generateGhProjectSkill(mockCtx);
    expect(result).toContain("Column Name");
    expect(result).toContain("Option ID");
  });

  it("includes all statusColumns in the table", () => {
    const result = generateGhProjectSkill(mockCtx);
    expect(result).toContain("opt_todo");
    expect(result).toContain("opt_review");
    expect(result).toContain("opt_done");
  });

  it("includes statusFieldId", () => {
    const result = generateGhProjectSkill(mockCtx);
    expect(result).toContain("PVTF_field123");
  });

  it("includes projectId", () => {
    const result = generateGhProjectSkill(mockCtx);
    expect(result).toContain("PVT_test123");
  });

  it("does not contain raw double-brace template variables", () => {
    const result = generateGhProjectSkill(mockCtx);
    expect(result).not.toMatch(/\{\{/);
  });
});
