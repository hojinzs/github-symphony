/** Design-only event fixtures. These are not management-plane protocol types. */
export type Child = 1019 | 1020 | 1021 | 1022;
export type PrototypeEvent =
  | { kind: "click"; label: string }
  | { kind: "key"; code: number }
  | { kind: "timeout" };
export interface Step {
  from: string;
  event: PrototypeEvent;
  to: string;
}
export interface WalkthroughFixture {
  child: Child;
  case: string;
  steps: Step[];
}
const click = (label: string): PrototypeEvent => ({ kind: "click", label });
const key = (code: number): PrototypeEvent => ({ kind: "key", code });
const timeout: PrototypeEvent = { kind: "timeout" };
const step = (from: string, event: PrototypeEvent, to: string): Step => ({
  from,
  event,
  to,
});

// Independently specified expectations, checked against exported Figma reactions.
export const walkthroughs: WalkthroughFixture[] = [
  {
    child: 1019,
    case: "enrollment",
    steps: [
      step(
        "Environments/empty",
        click("Add environment"),
        "Environments/create"
      ),
      step(
        "Environments/create",
        click("Create environment"),
        "Environments/waiting-linux"
      ),
      step(
        "Environments/waiting-linux",
        click("Copy setup command"),
        "Environments/setup-copy-success"
      ),
      step(
        "Environments/setup-copy-success",
        click("Copy token"),
        "Environments/copy-success"
      ),
      step(
        "Environments/copy-success",
        click("Close and keep environment"),
        "Environments/closed-pending"
      ),
      step(
        "Environments/closed-pending",
        click(
          "build-host | Pending enrollment | Not reported yet | — | No signal received"
        ),
        "Environments/reopened"
      ),
      step(
        "Environments/reopened",
        click("Regenerate token"),
        "Environments/waiting-linux"
      ),
      step("Environments/waiting-linux", key(70), "Environments/copy-failure"),
      step("Environments/copy-failure", key(69), "Environments/expired"),
      step(
        "Environments/expired",
        click("Regenerate token"),
        "Environments/waiting-linux"
      ),
      step("Environments/waiting-linux", timeout, "Environments/enrolled"),
      step(
        "Environments/enrolled",
        click("Close and keep environment"),
        "Environments/closed-enrolled"
      ),
      step(
        "Environments/closed-enrolled",
        timeout,
        "Environments/closed-online"
      ),
      step("Environments/enrolled", timeout, "Environments/connected"),
      step("Environments/create", key(73), "Environments/name-error"),
      step(
        "Environments/waiting-linux",
        key(67),
        "Environments/setup-copy-failure"
      ),
    ],
  },
  {
    child: 1020,
    case: "fleet",
    steps: [
      step("Projects/fleet", click("All states"), "Projects/filtered"),
      step(
        "Projects/filtered",
        click("Offline / historical"),
        "Projects/fleet"
      ),
      step("Projects/fleet", key(79), "Project detail/offline"),
      step(
        "Project detail/running",
        click("Runs & logs"),
        "Runs and logs/following"
      ),
      step(
        "Project detail/running",
        click("Commands"),
        "Commands and recovery/history"
      ),
    ],
  },
  {
    child: 1021,
    case: "lifecycle",
    steps: [
      step(
        "Project detail/running",
        click("Stop project"),
        "Commands and recovery/stop-confirm"
      ),
      step(
        "Commands and recovery/stop-confirm",
        click("Cancel"),
        "Project detail/running"
      ),
      step(
        "Commands and recovery/stop-confirm",
        key(27),
        "Project detail/running"
      ),
      step(
        "Commands and recovery/stop-confirm",
        click("Stop project"),
        "Commands and recovery/accepted"
      ),
      step(
        "Commands and recovery/accepted",
        timeout,
        "Commands and recovery/executing"
      ),
      step(
        "Commands and recovery/executing",
        timeout,
        "Commands and recovery/succeeded"
      ),
      step(
        "Project detail/stopped",
        click("Start project"),
        "Commands and recovery/start-accepted"
      ),
      step(
        "Commands and recovery/start-accepted",
        timeout,
        "Commands and recovery/start-executing"
      ),
      step(
        "Commands and recovery/start-executing",
        timeout,
        "Commands and recovery/start-succeeded"
      ),
      step(
        "Commands and recovery/executing",
        key(85),
        "Commands and recovery/unknown"
      ),
    ],
  },
  {
    child: 1021,
    case: "closure",
    steps: [
      step(
        "Commands and recovery/unknown",
        click("Review unresolved closure"),
        "Commands and recovery/reason-error"
      ),
      step(
        "Commands and recovery/reason-error",
        click(""),
        "Commands and recovery/reason-filled"
      ),
      step(
        "Commands and recovery/reason-filled",
        click("Review unresolved closure"),
        "Commands and recovery/closure-confirm"
      ),
      step(
        "Commands and recovery/closure-confirm",
        click("Back"),
        "Commands and recovery/reason-filled"
      ),
      step(
        "Commands and recovery/closure-confirm",
        key(27),
        "Commands and recovery/reason-filled"
      ),
      step(
        "Commands and recovery/closure-confirm",
        click("Close unresolved"),
        "Commands and recovery/closed-unresolved"
      ),
    ],
  },
  {
    child: 1022,
    case: "logs",
    steps: [
      step(
        "Runs and logs/following",
        click("Pause follow"),
        "Runs and logs/paused"
      ),
      step(
        "Runs and logs/paused",
        click("Resume follow"),
        "Runs and logs/following"
      ),
      step(
        "Runs and logs/following",
        click("Run / stream | run-1048 / worker.log  ▾"),
        "Runs and logs/selected-stream"
      ),
      step("Runs and logs/following", key(82), "Runs and logs/rotation"),
      step(
        "Runs and logs/rotation",
        click("Reset cursor"),
        "Runs and logs/following"
      ),
      step("Runs and logs/following", key(79), "Runs and logs/offline"),
      step("Runs and logs/offline", key(67), "Runs and logs/paused"),
      step("Runs and logs/following", key(77), "Runs and logs/unavailable"),
      step(
        "Runs and logs/unavailable",
        click("Request log again"),
        "Runs and logs/loading"
      ),
      step("Runs and logs/loading", key(90), "Runs and logs/empty"),
      step("Runs and logs/following", key(69), "Runs and logs/expired-read"),
    ],
  },
];
