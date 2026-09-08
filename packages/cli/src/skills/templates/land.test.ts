import { describe, expect, it } from "vitest";
import { generateLandSkill } from "./land.js";
import type { SkillTemplateContext } from "../types.js";

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
    expect(generated).toContain("published by the agent");
    expect(generated).toContain("never send `comment_body`");
    expect(generated).not.toMatch(/\{\{/);
  });
});

describe("merged-PR lifecycle guards", () => {
  it("documents every Land lifecycle exit and in-cycle conflict recovery", () => {
    const generatedLandSkill = generateLandSkill(context);

    expect(generatedLandSkill).toContain(
      "send `Land` → `In review` transition intent"
    );
    expect(generatedLandSkill).toContain(
      "send `Land` → `Ready` transition intent"
    );
    expect(generatedLandSkill).toContain(
      "send `Land` → `Backlog` transition intent"
    );
    expect(generatedLandSkill).toContain("**Trivial conflict**");
    expect(generatedLandSkill).toContain("remaining in `Land`");

    expect(generatedLandSkill).toContain("the repository lockfile");
    expect(generatedLandSkill).toContain(
      "regenerate the lockfile with the repository package manager"
    );
    expect(generatedLandSkill).toContain("through the pull skill");
    expect(generatedLandSkill).toContain(
      "outside the trivial set defined in item 4"
    );
    expect(generatedLandSkill).not.toContain("pnpm-lock.yaml");
  });

  it("places generated land-skill merged precedence before pre-flight and failure classification", () => {
    const landSkill = generateLandSkill(context);

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
    expect(failure).toContain(
      "**Approval or other external wait-only failure**"
    );
    expect(failure).toContain("send `Land` → `In review` transition intent");
    expect(failure).toContain("This is not a `⛔ Blocker` and is not rework");
    expect(failure).toContain("**External or permission blocker**");
    expect(failure).toContain("send `Land` → `Backlog` transition intent");
    expect(failure).toContain(
      "\n\nFor every classification, send only transition intent"
    );
    expect(landSkill).toContain(
      "publish the prepared body through `github_graphql`"
    );
    expect(landSkill).not.toContain("send it as `comment_body`");
    expect(landSkill).not.toContain("include it as `comment_body`");
    expect(landSkill).not.toContain("via `/gh-project` with that body");
  });

  it("gates Land rework on actionable threads created after approval", () => {
    const landSkill = generateLandSkill(context);

    expect(landSkill).not.toContain("Ready-return Rework Guard");
    expect(landSkill).not.toContain("`Ready` → `Done`");
    expect(landSkill).toContain("through `github_graphql`");
    expect(landSkill).toContain(
      "headRefOid reviews(last:30){nodes{state body author{login __typename} submittedAt commit{oid}}}"
    );
    expect(landSkill).toContain("`state == APPROVED`");
    expect(landSkill).toContain("`author.__typename != Bot`");
    expect(landSkill).toContain("`commit.oid == headRefOid`");
    expect(landSkill).toContain("comments(first: 1)");
    expect(landSkill).toContain("createdAt");
    expect(landSkill).toContain("approval's `submittedAt`");
    expect(landSkill).toContain(
      "created at or before that approval is absorbed by the approval"
    );
    expect(landSkill).toContain("reason `Land-return rework: <cause>`");
    expect(landSkill).toContain("send `Land` → `Ready` transition intent");
    expect(landSkill).toContain(
      "compare its first comment's `createdAt` with the approval's `submittedAt`"
    );
    expect(landSkill).toContain(
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
