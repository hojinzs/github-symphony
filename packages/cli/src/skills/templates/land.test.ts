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
    expect(generated).toMatch(/## (Rules|Flow)/);
    expect(generated).toContain("gh pr merge");
    expect(generated).toContain("gh-project");
    expect(generated).not.toMatch(/\{\{/);
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

  it("gates Land rework on actionable threads created after approval", async () => {
    const workflow = await repositoryFile("WORKFLOW.md");
    const landSkill = await repositoryFile(".codex/skills/land/SKILL.md");

    expect(landSkill).toContain("comments(first: 1)");
    expect(landSkill).toContain("createdAt");
    expect(landSkill).toContain("approval's `submittedAt`");
    expect(landSkill).toContain(
      "created at or before that approval is absorbed by the approval"
    );
    expect(workflow).toContain(
      "thread's first comment `createdAt` with the approval review's `submittedAt`"
    );
    expect(workflow).toContain(
      "created at or before that approval is absorbed by the approval"
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
    expect(generated).toContain("gh pr view <pr-number>");
    expect(generated).toContain("Never return a merged PR to `Ready`");
    expect(generated).toContain("Re-run the Merged-PR Precedence Guard first");
  });
});
