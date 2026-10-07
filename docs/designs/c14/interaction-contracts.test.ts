import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { walkthroughs } from "./walkthrough-fixtures.ts";
import type { PrototypeEvent } from "./walkthrough-fixtures.ts";

interface Edge {
  source: string;
  label: string;
  width: number;
  height: number;
  destination: string;
  trigger: { type: string; keyCodes?: number[]; timeout?: number };
}
interface Screen {
  id: string;
  source: string;
  name: string;
  width: number;
  text: string;
  edges: Edge[];
  controls: { id: string; width: number; height: number }[];
  annotations: { label: string }[];
  recoveryField?: {
    id: string;
    name: string;
    width: number;
    height: number;
    text: string;
    annotations: { label: string }[];
  };
}
const manifest = JSON.parse(
  readFileSync(new URL("./prototype-evidence.json", import.meta.url), "utf8")
) as { screens: Screen[]; evidenceStage: string };
const screens = manifest.screens;
const screen = (key: string): Screen => {
  const result = screens.find((s) => s.name === `Screen/${key}/1440`);
  assert.ok(result, `missing screen ${key}`);
  return result;
};
const matches = (edge: Edge, event: PrototypeEvent): boolean => {
  if (event.kind === "click") {
    return (
      edge.trigger.type === "ON_CLICK" &&
      edge.label === event.label &&
      (!event.source || edge.source === event.source)
    );
  }
  if (event.kind === "key") {
    return (
      edge.trigger.type === "ON_KEY_DOWN" &&
      edge.trigger.keyCodes?.[0] === event.code
    );
  }
  return edge.trigger.type === "AFTER_TIMEOUT";
};

for (const fixture of walkthroughs) {
  test(`${fixture.case}: actual Figma graph satisfies child ${fixture.child} fixtures`, () => {
    for (const step of fixture.steps) {
      const from = screen(step.from);
      const target = screen(step.to);
      assert.ok(
        from.edges.some(
          (edge) => matches(edge, step.event) && edge.destination === target.id
        ),
        `${fixture.case}: ${step.from} ${JSON.stringify(step.event)} must reach ${step.to}`
      );
    }
  });
}

test("snapshot integrity, responsive sizes and reachable target bounds", () => {
  assert.equal(screens.length, 72);
  assert.equal(new Set(screens.map((s) => s.id)).size, screens.length);
  assert.ok(manifest.evidenceStage.includes("pending"));
  for (const width of [1440, 1024, 390]) {
    assert.ok(screens.some((s) => s.width === width));
  }
  for (const s of screens) {
    assert.ok(s.source);
    assert.ok(
      s.annotations.some((a) => a.label.includes("synthetic prototype"))
    );
    for (const edge of s.edges) {
      assert.ok(
        screens.some((target) => target.id === edge.destination),
        `dangling edge ${edge.source}`
      );
      if (edge.trigger.type === "ON_CLICK") {
        assert.ok(
          edge.width >= 24 && edge.height >= 24,
          `small target ${edge.source}`
        );
      }
    }
  }
});

test("token absence, zero-project success, disabled safety and retained unknown audit", () => {
  for (const state of [
    "reopened",
    "expired",
    "enrolled",
    "closed-pending",
    "closed-enrolled",
    "closed-online",
  ]) {
    assert.ok(
      !screen(`Environments/${state}`).text.includes("Copy token"),
      state
    );
  }
  assert.match(
    screen("Environments/connected").text,
    /0 projects is a successful connection/
  );
  assert.match(
    screen("Environments/copy-failure").text,
    /Could not copy token/
  );
  assert.match(
    screen("Environments/setup-copy-failure").text,
    /Could not copy setup command/
  );
  assert.match(
    screen("Commands and recovery/reason-filled").text,
    /Inspected the host/
  );
  assert.match(
    screen("Commands and recovery/closed-unresolved").text,
    /Outcome is still unknown/
  );
  assert.match(
    screen("Commands and recovery/closed-unresolved").text,
    /Reason:/
  );
  for (const state of ["offline", "stale", "unmanaged", "incompatible"]) {
    assert.ok(
      !screen(`Project detail/${state}`).edges.some(
        (e) => e.label === "Start project" || e.label === "Stop project"
      )
    );
  }
  for (const state of [
    "unknown",
    "reason-error",
    "reason-filled",
    "closed-unresolved",
  ]) {
    assert.ok(
      !screen(`Commands and recovery/${state}`).edges.some((e) =>
        /retry/i.test(e.label)
      )
    );
  }
  assert.match(
    screen("Commands and recovery/start-accepted").text,
    /last observed stopped/
  );
  assert.match(
    screen("Commands and recovery/start-succeeded").text,
    /running verified/
  );
});

// Checks actual Figma readback; browser selection/readonly semantics remain a UI gate.
test("clipboard failure has a labelled synthetic manual token selection surface", () => {
  const failure = screen("Environments/copy-failure");
  const field = failure.recoveryField;
  assert.ok(field, "copy failure must render a token recovery field");
  assert.equal(field.name, "Component/Field/EnrollmentTokenReadonly");
  assert.ok(
    failure.controls.some((control) => control.id === field.id),
    "recovery field must be present in exported visible controls"
  );
  assert.match(failure.text, /Enrollment token \(read only\)/);
  assert.match(failure.text, /DEMO-C14-NOT-A-REAL-TOKEN/);
  assert.match(field.text, /Ctrl\+A \/ Command\+A selects its value/);
  assert.ok(field.width > 0 && field.height >= 24);
  assert.match(
    field.annotations.map((a) => a.label).join(" "),
    /native readonly text input.*focusable and selectable with keyboard\/pointer/
  );
  for (const other of screens.filter((s) => s.id !== failure.id)) {
    assert.ok(
      !other.text.includes("DEMO-C14-NOT-A-REAL-TOKEN"),
      `issuance value must not leak into ${other.name}`
    );
    assert.ok(
      !other.recoveryField,
      `recovery field must not persist in ${other.name}`
    );
  }
});
