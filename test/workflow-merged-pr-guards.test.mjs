import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflow = await readFile(
  new URL("../WORKFLOW.md", import.meta.url),
  "utf8"
);

function section(start, end) {
  const startIndex = workflow.indexOf(start);
  const endIndex = workflow.indexOf(end, startIndex + start.length);

  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);

  return workflow.slice(startIndex, endIndex);
}

test("declares merged PR completion as a global lifecycle invariant", () => {
  assert.match(workflow, /\*\*Merged-PR invariant\.\*\*/);
  assert.match(workflow, /A merged issue must never transition to `Ready`\./);
});

test("Ready checks MERGED before review rework classification", () => {
  const readyGuard = section(
    "##### Ready-return rework guard",
    "##### Stalled-handoff safety net"
  );
  const mergedGuard = readyGuard.indexOf("**Merged-PR precedence guard:**");
  const reworkClassification = readyGuard.indexOf("`CHANGES_REQUESTED`");

  assert.notEqual(mergedGuard, -1);
  assert.notEqual(reworkClassification, -1);
  assert.ok(mergedGuard < reworkClassification);
  assert.match(readyGuard, /`🔁 Status: Ready → Done`/);
  assert.match(readyGuard, /Do not open a new cycle/);
});

test("Land checks MERGED before pre-flight and failure classification", () => {
  const landStep = section(
    "#### Step 4: Land — squash merge and complete",
    "### Guardrails"
  );
  const preflightMergedGuard = landStep.indexOf(
    "merged-PR precedence guard before any pre-flight check"
  );
  const preflightChecks = landStep.indexOf(
    "Pre-flight checks (approval, required CI checks"
  );
  const failureSection = section(
    "4. **On `/land` failure or wait.**",
    "This step performs no code edits"
  );
  const failureMergedGuard = failureSection.indexOf(
    "**Merged-PR precedence guard (always first)**"
  );
  const reworkFailure = failureSection.indexOf("**Rework failure**");

  assert.ok(
    preflightMergedGuard >= 0 && preflightMergedGuard < preflightChecks
  );
  assert.ok(failureMergedGuard >= 0 && failureMergedGuard < reworkFailure);
  assert.match(failureSection, /`🔁 Status: Land → Done`/);
  assert.match(failureSection, /Never classify a merged PR as rework/);
});
