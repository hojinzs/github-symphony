import { expect, it } from "vitest";
import {
  commandRecordSchema,
  type CommandRecord,
} from "@gh-symphony/management-protocol";
import {
  commandProgress,
  recoveryPanel,
  renderCommandConfirmation,
  renderCommandDetail,
  renderCommandHistory,
  renderClosureConfirmation,
  type CommandContext,
} from "./command-pages.js";

const id = "11111111-1111-4111-8111-111111111111";
const submittedAt = "2026-10-16T09:00:00Z";
function command(state: CommandRecord["state"]): CommandRecord {
  return commandRecordSchema.parse({
    commandId: id,
    projectId: id,
    environmentId: id,
    localProjectId: "prepared",
    sessionId: id,
    operation: "stop",
    actor: "local-owner",
    idempotencyKey: "original-intent",
    submittedAt,
    expiresAt: "2026-10-16T09:00:30Z",
    state,
    ...(!["accepted", "expired"].includes(state)
      ? {
          claimedAt: "2026-10-16T09:00:01Z",
          owner: { agentId: id, sessionId: id },
        }
      : {}),
    ...(["succeeded", "failed"].includes(state)
      ? {
          completedAt: "2026-10-16T09:00:02Z",
          evidence: { verified: true, process: { state: "stopped" } },
        }
      : {}),
  });
}
const context: CommandContext = {
  environment: "Linux <host>",
  disabledReasons: {},
  project: {
    projectId: id,
    environmentId: id,
    localProjectId: "prepared",
    managed: true,
    connection: "online",
    fresh: true,
    snapshotStale: false,
    lastReceivedAt: "2026-10-16T09:00:11Z",
    warnings: [],
    observation: {
      projectId: id,
      localProjectId: "prepared",
      displayName: "Prepared <script>",
      canonicalPath: "/prepared",
      cliVersion: "1.0.0",
      validation: { state: "valid" },
      process: {
        state: "running",
        identity: "replacement",
        pid: 42,
        observedAt: "2026-10-16T09:00:10Z",
      },
      observedAt: submittedAt,
      snapshotObservedAt: submittedAt,
      snapshot: { summary: { activeRuns: 3 } },
      runs: [],
    },
  },
};
it("renders all protocol outcomes without substituting process observations", () => {
  for (const state of [
    "accepted",
    "executing",
    "succeeded",
    "failed",
    "expired",
    "unknown",
  ] as const) {
    const html = commandProgress(command(state));
    expect(html).toContain(`stop · ${state}`);
    expect(html).toContain('role="status"');
    expect(html).toContain(submittedAt);
  }
  expect(commandProgress(command("accepted"))).toContain(
    "process state is unchanged"
  );
  expect(commandProgress(command("executing"))).toContain(
    "verified outcome has not arrived"
  );
  expect(commandProgress(command("expired"))).toContain(
    "did not authorize execution"
  );
  const html = renderCommandDetail(context, command("succeeded"), "csrf");
  expect(html).toContain("Verified command outcome: succeeded");
  expect(html).toContain("running · online");
  expect(html).toContain("2026-10-16T09:00:02Z");
  expect(html).toContain("2026-10-16T09:00:10Z");
});
it("names superseded targets and escapes diagnostics and evidence", () => {
  const row = command("failed");
  row.diagnostic = { code: "superseded_target", message: "<unsafe>" };
  row.evidence = { identity: "<replacement>" };
  const html = commandProgress(row);
  expect(html).toContain("replacement process was not stopped by this command");
  expect(html).toContain("&lt;unsafe&gt;");
  expect(html).toContain("&lt;replacement&gt;");
  expect(html).not.toContain("<unsafe>");
});
it("requires a reason and a second closure confirmation while retaining unknown audit", () => {
  const row = command("unknown");
  const html = recoveryPanel(row, 'csrf"value');
  expect(html).toContain('name="reason" required maxlength="2048"');
  expect(html).toContain(`/commands/${id}/closure-confirmation`);
  expect(html).toContain("second confirmation follows");
  expect(html).toContain("csrf&quot;value");
  expect(html).not.toMatch(/>Retry<|\/close-unresolved/);
  const confirmation = renderClosureConfirmation(
    row,
    "Inspected <host>",
    "csrf"
  );
  expect(confirmation).toContain('name="acknowledge" value="true"');
  expect(confirmation).toContain("Confirm close unresolved");
  expect(confirmation).toContain("Inspected &lt;host&gt;");
  row.closure = {
    closedAt: "2026-10-16T09:02:00Z",
    actor: "local-owner",
    reason: "Inspected host",
  };
  const closed = recoveryPanel(row, "csrf");
  expect(closed).toContain("Closed unresolved · outcome unknown");
  expect(closed).toContain("local-owner");
  expect(closed).toContain("Inspected host");
  expect(closed).not.toContain("<form");
  expect(recoveryPanel(command("accepted"), "csrf")).toBe("");
});
it("confirms stop impact and renders backend and stale admission reasons", () => {
  const form = { csrf: "csrf", idempotencyKey: "intent" };
  const html = renderCommandConfirmation(context, "stop", form);
  expect(html).toContain("Prepared &lt;script&gt; on Linux &lt;host&gt;");
  expect(html).toContain("3 observed active runs");
  expect(html).toContain("Stopping interrupts active runs");
  expect(html).toContain('method="post"');
  expect(html).toContain('name="idempotencyKey" value="intent"');
  expect(html).not.toContain(" disabled");
  const blocked = renderCommandConfirmation(
    { ...context, disabledReasons: { stop: "Agent capacity reached" } },
    "stop",
    form
  );
  expect(blocked).toContain('disabled aria-describedby="eligibility-reason"');
  expect(blocked).toContain("Agent capacity reached");
  const stale = renderCommandConfirmation(
    { ...context, project: { ...context.project, fresh: false } },
    "stop",
    form
  );
  expect(stale).toContain("Observation is stale");
  expect(stale).toContain(" disabled");
  expect(renderCommandConfirmation(context, "start", form)).toContain(
    "Start requires a verified stopped process"
  );
});
it("keeps closed unknown in paged history and escapes cursor inputs", () => {
  const row = command("unknown");
  row.closure = {
    closedAt: "2026-10-16T09:02:00Z",
    actor: "local-owner",
    reason: "Inspection",
  };
  const html = renderCommandHistory(context, {
    items: [row],
    nextCursor: 'next"<',
  });
  expect(html).toContain("stop · unknown · closed unresolved");
  expect(html).toContain(`/commands/${id}`);
  expect(html).toContain("cursor=next%22%3C");
  expect(renderCommandHistory(context, { items: [] })).toContain(
    "No commands yet"
  );
});
