import { describe, it, expect } from "vitest";
import { generateGhProjectSkill } from "./gh-project.js";
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
  detectedEnvironment: {
    packageManager: "pnpm",
    testCommand: "pnpm test",
    lintCommand: "pnpm lint",
    buildCommand: "pnpm build",
    monorepo: false,
  },
};

describe("generateGhProjectSkill", () => {
  it("returns a non-empty string", () => {
    const result = generateGhProjectSkill(mockCtx);
    expect(result.length).toBeGreaterThan(100);
  });

  it("uses the run-scoped orchestrator tracker API", () => {
    const result = generateGhProjectSkill(mockCtx);
    expect(result).toContain("/api/v1/tracker-state");
    expect(result).toContain("X-Symphony-Run-Id");
    expect(result).toContain('"transition-request"');
  });

  it("does not expose board traversal or direct mutation commands", () => {
    const result = generateGhProjectSkill(mockCtx);
    expect(result).not.toContain("gh project item-list");
    expect(result).not.toContain("gh project item-edit");
    expect(result).not.toContain("ProjectV2");
    expect(result).not.toContain("PVT_test123");
    expect(result).not.toContain("PVTF_field123");
  });

  it("requires confirmed readback before lifecycle comments", () => {
    const result = generateGhProjectSkill(mockCtx);
    expect(result).toContain('.outcome == "confirmed"');
    expect(result).toContain("only after");
  });

  it("does not contain raw double-brace template variables", () => {
    const result = generateGhProjectSkill(mockCtx);
    expect(result).not.toMatch(/\{\{/);
  });
});
