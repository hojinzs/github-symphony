import { describe, it, expect } from "vitest";
import { generateGhSymphonySkill } from "./gh-symphony.js";
import type { SkillTemplateContext } from "../types.js";

const mockCtx: SkillTemplateContext = {
  runtime: "claude-code",
  projectId: "PVT_test123",
  githubProjectTitle: "Test Project",
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

describe("generateGhSymphonySkill", () => {
  it("returns a non-empty string", () => {
    const result = generateGhSymphonySkill(mockCtx);
    expect(result.length).toBeGreaterThan(100);
  });

  it("contains Mode Detection section", () => {
    const result = generateGhSymphonySkill(mockCtx);
    expect(result).toContain("Mode Detection");
  });

  it("contains Design Mode section", () => {
    const result = generateGhSymphonySkill(mockCtx);
    expect(result).toContain("Design Mode");
  });

  it("contains Refine Mode section", () => {
    const result = generateGhSymphonySkill(mockCtx);
    expect(result).toContain("Refine Mode");
  });

  it("references context.yaml path from ctx", () => {
    const result = generateGhSymphonySkill(mockCtx);
    expect(result).toContain(".gh-symphony/context.yaml");
  });

  it("references reference-workflow.md path from ctx", () => {
    const result = generateGhSymphonySkill(mockCtx);
    expect(result).toContain(".gh-symphony/reference-workflow.md");
  });

  it("lists related skills", () => {
    const result = generateGhSymphonySkill(mockCtx);
    expect(result).toContain("gh-project");
    expect(result).toContain("commit");
    expect(result).toContain("land");
  });

  it("does not contain raw double-brace template variables", () => {
    const result = generateGhSymphonySkill(mockCtx);
    expect(result).not.toMatch(/\{\{/);
  });
});
