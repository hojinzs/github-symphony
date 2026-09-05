import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { generateLandSkill } from "./land.js";
import type { SkillTemplateContext } from "../types.js";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../.."
);

async function repositoryFile(path: string): Promise<string> {
  return readFile(resolve(repositoryRoot, path), "utf8");
}

function section(document: string, start: string, end: string): string {
  const startIndex = document.indexOf(start);
  const endIndex = document.indexOf(end, startIndex + start.length);

  expect(startIndex, `missing section start: ${start}`).toBeGreaterThanOrEqual(
    0
  );
  expect(endIndex, `missing section end: ${end}`).toBeGreaterThan(startIndex);
  return document.slice(startIndex, endIndex);
}

const context: SkillTemplateContext = {
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

describe("generateLandSkill", () => {
  it("generates the baseline merge workflow", () => {
    const generated = generateLandSkill(context);

    expect(generated.length).toBeGreaterThan(50);
    expect(generated).toMatch(/## .*Rules/);
    expect(generated).toContain("mergePullRequest");
    expect(generated).toContain("gh-project");
    expect(generated).toContain("github_graphql");
    expect(generated).not.toContain("gh pr ");
    expect(generated).not.toMatch(/\{\{/);
  });

  it("preserves a standing approval across the Land cycle's guarded base merge", () => {
    const generated = generateLandSkill(context);

    expect(generated).toContain("## Base-merge Approval Exemption");
    expect(generated).toContain("approvedHeadOid");
    expect(generated).toContain("expectedHeadOid: $approvedHeadOid");
    expect(generated).toContain("updateMethod: MERGE");
    expect(generated).toContain(
      "Do not require a second approval on that base-only merge head."
    );
    expect(generated).toContain(
      "classify that as an external wait and return `Land` → `In review`"
    );
    expect(generated).not.toContain("If not up-to-date, run the `/pull` skill");
  });
});

describe("merged-PR lifecycle guards", () => {
  it("places Ready merged precedence before rework classification and verifies candidate linkage", async () => {
    const workflow = await repositoryFile("WORKFLOW.md");
    const ready = section(
      workflow,
      "##### Ready-return rework guard",
      "##### Stalled-handoff safety net"
    );

    const readyGuardIndex = ready.indexOf("**Merged-PR precedence guard:**");
    const reworkIndex = ready.indexOf("`CHANGES_REQUESTED`");
    expect(readyGuardIndex).toBeGreaterThanOrEqual(0);
    expect(reworkIndex).toBeGreaterThan(readyGuardIndex);
    expect(ready).toContain("closingIssuesReferences");
    expect(ready).toContain("text-search match alone is never linked evidence");
    expect(ready).toContain("current delivery PR is `MERGED`");
    expect(workflow).toContain("**Merged-PR invariant.**");
    expect(workflow).toContain(
      "An issue whose current delivery PR is merged must never transition to `Ready`."
    );
    expect(workflow).toContain(
      "| `Ready` → `Done` (merged-PR precedence repair)"
    );
  });

  it("places installed land-skill merged precedence before pre-flight and failure classification", async () => {
    const landSkill = await repositoryFile(".codex/skills/land/SKILL.md");

    const guardIndex = landSkill.indexOf("## Merged-PR Precedence Guard");
    const preflightIndex = landSkill.indexOf("## Pre-flight Checks");
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(preflightIndex).toBeGreaterThan(guardIndex);
    const failure = section(landSkill, "## Failure Handling", "## Guardrails");
    const failureGuardIndex = failure.indexOf(
      "**Merged-PR precedence is always first.**"
    );
    const reworkFailureIndex = failure.indexOf("**Rework failure**");
    expect(failureGuardIndex).toBeGreaterThanOrEqual(0);
    expect(reworkFailureIndex).toBeGreaterThan(failureGuardIndex);
    expect(failure).toContain(
      "A deleted head branch is not rework after merge"
    );
  });

  it("generates the same precedence guard in the published CLI land skill", () => {
    const generated = generateLandSkill(context);

    const guardIndex = generated.indexOf("## Merged-PR Precedence Guard");
    const preflightIndex = generated.indexOf("## Pre-flight Checks");
    expect(guardIndex).toBeGreaterThanOrEqual(0);
    expect(preflightIndex).toBeGreaterThan(guardIndex);
    expect(generated).toContain(
      "Before any pre-flight check or failure classification"
    );
    expect(generated).toContain("by PR number");
    expect(generated).toContain("Never return a merged PR to `Ready`");
    expect(generated).toContain(
      "Re-run the Merged-PR Precedence Guard before classifying any failure"
    );
  });
});
