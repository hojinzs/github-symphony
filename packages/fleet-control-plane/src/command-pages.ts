import type {
  CommandRecord,
  LifecycleOperation,
  Page,
} from "@gh-symphony/management-protocol";
import type { ObservedProject } from "./observations.js";
import { escapeHtml as e, projectDocument } from "./project-pages.js";
import { presentProject } from "./project-presentation.js";

/** Presentation input only; the command service rechecks admission on submission. */
export interface CommandContext {
  project: ObservedProject;
  environment: string;
  /** Service-owned admission reasons (conflict, capacity, stale target, etc.). */
  disabledReasons: Partial<Record<LifecycleOperation, string>>;
}
export interface CommandForm {
  csrf: string;
  idempotencyKey: string;
}
const time = (label: string, value: string | undefined) =>
  `<div><dt>${label}</dt><dd>${value ? `<time datetime="${e(value)}">${e(value)}</time>` : "Not available"}</dd></div>`;
const hidden = (name: string, value: string) =>
  `<input type="hidden" name="${name}" value="${e(value)}">`;
const base = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}/commands`;

/** CommandProgress: outcome never changes the independently observed process. */
export function commandProgress(command: CommandRecord): string {
  const descriptions: Record<CommandRecord["state"], string> = {
    accepted:
      "Accepted. Waiting for the agent to claim this command; process state is unchanged until independently observed.",
    executing:
      "Executing. The agent claimed this command; a verified outcome has not arrived.",
    succeeded:
      "Verified command outcome: succeeded. Inspect current process observations separately.",
    failed:
      "Verified command outcome: failed. Review the diagnostic and evidence before a fresh command.",
    expired:
      "Expired before claim. This command did not authorize execution; a fresh command requires current eligibility.",
    unknown:
      "Outcome unknown. This command may have executed. Do not replay it or assume the process stopped.",
  };
  return `<section class="command-progress" aria-labelledby="outcome-${e(command.commandId)}"><h2 id="outcome-${e(command.commandId)}">${e(command.operation)} · ${e(command.state)}</h2><p role="status">${descriptions[command.state]}</p>${command.diagnostic ? `<p class="notice warning">${e(command.diagnostic.code)}: ${e(command.diagnostic.message)}</p>` : ""}${command.diagnostic?.code === "superseded_target" ? '<p class="notice warning">The target process was replaced. The replacement process was not stopped by this command.</p>' : ""}<dl class="command-times">${time("Submitted", command.submittedAt)}${time("Claim deadline", command.expiresAt)}${time("Claimed", command.claimedAt)}${time("Outcome verified", command.completedAt)}</dl>${command.evidence !== undefined ? `<details><summary>Last command evidence</summary><pre>${e(JSON.stringify(command.evidence, null, 2))}</pre></details>` : '<p class="muted">No command evidence received.</p>'}<small>Command ${e(command.commandId)} · Target session ${e(command.sessionId)}</small></section>`;
}

/** RecoveryPanel: closure releases the management slot, preserving unknown. */
export function recoveryPanel(command: CommandRecord, csrf: string): string {
  if (command.state !== "unknown") return "";
  if (command.closure)
    return `<section class="recovery-panel"><h2>Closed unresolved · outcome unknown</h2><p>Closure did not verify success or stop a process. A fresh command still needs current eligibility and process verification.</p><dl>${time("Closed", command.closure.closedAt)}<dt>Actor</dt><dd>${e(command.closure.actor)}</dd><dt>Reason</dt><dd>${e(command.closure.reason)}</dd></dl></section>`;
  return `<section class="recovery-panel" aria-labelledby="recovery-title"><h2 id="recovery-title">Recover an unknown outcome</h2><p>Reconnect the agent and inspect local process evidence. Await reconciliation when possible. There is no automatic replay.</p><p>Closing unresolved releases only the management command slot. It does not stop a process, release a host lock or change the unknown outcome.</p><form method="post" action="/commands/${e(command.commandId)}/closure-confirmation">${hidden("csrf", csrf)}<label for="closure-reason">Resolution reason (required)</label><textarea id="closure-reason" name="reason" required maxlength="4096" aria-describedby="closure-help"></textarea><small id="closure-help">Record what you inspected and why the outcome remains unresolved. A second confirmation follows.</small><button type="submit">Review unresolved closure</button></form></section>`;
}

export function renderCommandDetail(
  context: CommandContext,
  command: CommandRecord,
  csrf: string
) {
  const p = presentProject(context.project);
  return projectDocument(
    "Command detail",
    `<a href="${base(p.projectId)}">Back to command history</a><h1>${e(p.name)} · ${e(context.environment)}</h1>${commandProgress(command)}<section class="process-observation"><h2>Independent process observation</h2><p>${p.historical ? "Last known " : ""}${e(p.process)} · ${e(p.connection)}</p><dl>${time("Process observed", p.processObservedAt)}${time("Fleet received", p.receivedAt)}</dl><p>Command outcomes describe the original target and verification time. Current observations may describe a replacement process.</p></section>${recoveryPanel(command, csrf)}<a class="button" href="/commands/${e(command.commandId)}">Refresh command and observations</a>`
  );
}

export function renderCommandHistory(
  context: CommandContext,
  page: Page<CommandRecord>
) {
  const p = presentProject(context.project);
  return projectDocument(
    "Commands",
    `<a href="/projects/${e(p.projectId)}">Back to project</a><h1>Commands · ${e(p.name)}</h1><p>${e(context.environment)} · ${e(p.localProjectId)}</p><section aria-label="Command history">${page.items.length ? page.items.map((command) => `<article class="command-history"><a href="/commands/${e(command.commandId)}">${e(command.operation)} · ${e(command.state)}${command.closure ? " · closed unresolved" : ""}</a><small>${e(command.commandId)}</small><dl>${time("Submitted", command.submittedAt)}${time("Outcome verified", command.completedAt)}</dl></article>`).join("") : '<p role="status">No commands yet.</p>'}</section>${page.nextCursor ? `<a class="button" href="${base(p.projectId)}?${e(new URLSearchParams({ cursor: page.nextCursor }).toString())}">Next commands</a>` : ""}`
  );
}

/** Dialog composition; GET is inert. Only an explicit POST may submit intent. */
export function renderCommandConfirmation(
  context: CommandContext,
  operation: LifecycleOperation,
  form: CommandForm
) {
  const p = presentProject(context.project);
  const reason =
    context.disabledReasons[operation] ??
    (operation === "start" ? p.startReason : p.stopReason);
  const label = operation === "stop" ? "Stop project" : "Start project";
  return projectDocument(
    `${label} confirmation`,
    `<a href="/projects/${e(p.projectId)}">Back to project</a><section class="command-dialog" aria-labelledby="confirm-title"><h1 id="confirm-title">${label}?</h1><p>${e(p.name)} on ${e(context.environment)}</p><small>${e(p.localProjectId)} · ${e(p.path)}</small><p>${p.activeWork === undefined ? "Active run count unavailable" : `${p.activeWork} observed active runs`}${p.snapshotHistorical ? " · historical" : ""} · Snapshot ${e(p.snapshotObservedAt ?? "unavailable")}</p>${operation === "stop" ? '<p class="notice warning">Stopping interrupts active runs. In-flight work may be interrupted; inspect local recovery before restarting.</p>' : "<p>Start requests a locally verified process startup. Accepted does not mean running.</p>"}<form method="post" action="${base(p.projectId)}">${hidden("csrf", form.csrf)}${hidden("idempotencyKey", form.idempotencyKey)}${hidden("operation", operation)}${reason ? `<p id="eligibility-reason" role="status">${e(reason)}</p>` : ""}<div class="actions"><a class="button" href="/projects/${e(p.projectId)}">Cancel</a><button type="submit"${operation === "stop" ? ' class="destructive"' : ""}${reason ? ' disabled aria-describedby="eligibility-reason"' : ""}>${label}</button></div></form></section>`
  );
}

export function renderClosureConfirmation(
  command: CommandRecord,
  reason: string,
  csrf: string
) {
  return projectDocument(
    "Confirm unresolved closure",
    `<section class="command-dialog" aria-labelledby="closure-title"><h1 id="closure-title">Close this command unresolved?</h1><p>Command ${e(command.commandId)} · ${e(command.operation)} · outcome unknown</p><p class="notice warning">This acknowledgment does not confirm success or stop any process. The outcome and audit history remain unknown.</p><h2>Resolution reason</h2><p>${e(reason)}</p><form method="post" action="/commands/${e(command.commandId)}/close-unresolved">${hidden("csrf", csrf)}${hidden("reason", reason)}${hidden("acknowledge", "true")}<div class="actions"><a class="button" href="/commands/${e(command.commandId)}">Cancel</a><button type="submit" class="destructive">Confirm close unresolved</button></div></form></section>`
  );
}
