import { describe, it, expect } from "vitest";
import { generateGhSymphonySkill } from "./gh-symphony.js";
import { GH_SYMPHONY_REFERENCE_FILES } from "./gh-symphony-references/index.js";
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

  it("uses WORKFLOW.md as the policy and config source", () => {
    const result = generateGhSymphonySkill(mockCtx);
    expect(result).toContain("WORKFLOW.md");
    expect(result).not.toContain(".gh-symphony/context.yaml");
    expect(result).not.toContain(".gh-symphony/reference-workflow.md");
  });

  it("references composable workflow reference files", () => {
    const result = generateGhSymphonySkill(mockCtx);
    expect(result).toContain("references/README.md");
    expect(result).toContain("references/workflow-schema.md");
    expect(result).toContain("references/workflow-posture-*.md");
  });

  it("lists related skills", () => {
    const result = generateGhSymphonySkill(mockCtx);
    expect(result).toContain("gh-project");
    expect(result).toContain("commit");
    expect(result).toContain("land");
  });

  it("includes detected repository validation guidance", () => {
    const result = generateGhSymphonySkill(mockCtx);
    expect(result).toContain("Repository Validation Guidance");
    expect(result).toContain("Detected repository validation commands:");
    expect(result).toContain("`pnpm test`");
    expect(result).not.toContain("(script:");
    expect(result).toContain("Use `pnpm` conventions");
  });

  it("does not contain raw double-brace template variables", () => {
    const result = generateGhSymphonySkill(mockCtx);
    expect(result).not.toMatch(/\{\{/);
  });
});

describe("gh-symphony reference files", () => {
  it("includes the expected reference file set", () => {
    expect(
      GH_SYMPHONY_REFERENCE_FILES.map((file) => file.relativePath)
    ).toEqual([
      "references/README.md",
      "references/workflow-schema.md",
      "references/workflow-posture-implement.md",
      "references/workflow-posture-review.md",
      "references/workflow-posture-maintain.md",
    ]);
  });

  it("generates the references index", () => {
    const readme = GH_SYMPHONY_REFERENCE_FILES[0]!.generate(mockCtx);
    expect(readme).toContain("# /gh-symphony references");
    expect(readme).toContain("workflow-posture-implement.md");
    expect(readme).toContain("workflow-posture-review.md");
    expect(readme).toContain("workflow-posture-maintain.md");
  });

  it("generates workflow schema reference content", () => {
    const schema = GH_SYMPHONY_REFERENCE_FILES[1]!.generate(mockCtx);
    expect(schema).toContain("# Reference WORKFLOW.md");
    expect(schema).toContain("tracker:");
    expect(schema).toContain("active_states:");
    expect(schema).toContain("Supported Template Variables");
  });

  it("generates implement posture content from current defaults", () => {
    const implement = GH_SYMPHONY_REFERENCE_FILES[2]!.generate(mockCtx);
    expect(implement).toContain("# Workflow posture: implement");
    expect(implement).toContain("### Default Posture");
    expect(implement).toContain("### Workpad Template");
    expect(implement).toContain("`pnpm test`");
  });

  it("generates review posture content", () => {
    const review = GH_SYMPHONY_REFERENCE_FILES[3]!.generate(mockCtx);
    expect(review).toContain("# Workflow posture: review");
    expect(review).toContain("Do NOT write code");
    expect(review).toContain("Do not create a workpad");
  });

  it("generates maintain posture content", () => {
    const maintain = GH_SYMPHONY_REFERENCE_FILES[4]!.generate(mockCtx);
    expect(maintain).toContain("# Workflow posture: maintain");
    expect(maintain).toContain("smallest possible change");
    expect(maintain).toContain("50 lines");
  });
});
