import { LOG_STREAMS, type LogStream } from "@gh-symphony/management-protocol";
import type { ObservedProject } from "./observations.js";
import {
  escapeHtml as e,
  projectDocument,
  type ProjectLinks,
} from "./project-pages.js";

export interface RunPageState {
  projectId: string;
  environmentId: string;
  online: boolean;
  lastObservedAt: string;
  runs: ObservedProject["observation"]["runs"];
}
export function runPageState(project: ObservedProject): RunPageState {
  return {
    projectId: project.projectId,
    environmentId: project.environmentId,
    online:
      project.connection === "online" &&
      project.fresh &&
      project.managed &&
      project.observation.validation.state === "valid",
    lastObservedAt: project.observation.observedAt,
    runs: project.observation.runs.slice(0, 100),
  };
}
export function renderRunPage(
  project: ObservedProject,
  environment: string,
  input: { page: number; runId?: string; stream: LogStream; csrfToken: string },
  links?: ProjectLinks
) {
  const state = runPageState(project);
  const base = "/projects/" + encodeURIComponent(project.projectId);
  const runs = state.runs;
  const selected = input.runId ?? runs[0]?.runId;
  const option = (runId: string, stream: string) =>
    '<option value="' +
    e(JSON.stringify([runId, stream])) +
    '"' +
    (selected === runId && input.stream === stream ? " selected" : "") +
    ">" +
    e(runId + " / " + stream) +
    "</option>";
  const page = Math.min(input.page, Math.max(1, Math.ceil(runs.length / 25)));
  const href = (n: number) =>
    base +
    "/runs?" +
    new URLSearchParams({
      page: String(n),
      ...(selected ? { run: selected } : {}),
      stream: input.stream,
    });
  const content = `<div class="run-page" id="run-page" data-project="${e(state.projectId)}" data-environment="${e(state.environmentId)}" data-online="${state.online}" data-observed="${e(state.lastObservedAt)}" data-csrf="${e(input.csrfToken)}">
<div class="heading"><div><h1>Runs and logs</h1><small>${e(project.observation.displayName)} · ${e(environment)} · Recorded runs and log output</small></div><a href="${base}">Back to project</a></div>
<small class="run-identity">Environment ${e(state.environmentId)} · Project ${e(state.projectId)}</small>
<section class="history-panel" aria-labelledby="history-heading"><h2 id="history-heading">Recent runs</h2><small><span id="history-status">${state.online ? "Recorded summaries" : "Historical summaries"}</span> · Last observed <time id="history-observed" datetime="${e(state.lastObservedAt)}">${e(state.lastObservedAt)}</time></small>
${
  runs
    .slice((page - 1) * 25, page * 25)
    .map(
      (run) =>
        `<article class="timeline-item"><a href="${e(base + "/runs?" + new URLSearchParams({ run: run.runId, stream: input.stream, page: String(page) }))}">${e(run.runId)} · ${e(project.localProjectId)}</a><p>${e(run.status)} · Started <time datetime="${e(run.startedAt)}">${e(run.startedAt)}</time></p><small>Last observed ${e(run.updatedAt)}</small></article>`
    )
    .join("") || "<p>No recorded runs. No log selection is available.</p>"
}
<div class="run-pagination"><small>${runs.length ? (page - 1) * 25 + 1 : 0}–${Math.min(page * 25, runs.length)} of ${runs.length} runs</small>${page > 1 ? `<a class="button" href="${e(href(page - 1))}">Previous runs</a>` : ""}${page * 25 < runs.length ? `<a class="button" href="${e(href(page + 1))}">Next runs</a>` : ""}<a href="${e(href(page))}">Refresh history</a></div></section>
<section class="log-panel" aria-label="Run log"><div class="log-toolbar"><label>Run / stream<select id="log-selection" ${selected ? "" : "disabled"} aria-describedby="log-help">${runs.flatMap((run) => LOG_STREAMS.map((stream) => option(run.runId, stream))).join("")}</select></label><span class="log-badge" id="log-badge">${state.online ? "Paused" : "Historical · follow paused"}</span><button id="log-follow" type="button" ${state.online && selected ? "" : "disabled"}>Follow</button><button id="log-read" type="button" ${state.online && selected ? "" : "disabled"}>Request fresh read</button><button id="log-reset" type="button" hidden>Reset cursor</button><button id="log-reconnect" type="button" ${state.online ? "hidden" : ""}>Check connection</button></div>
<p id="log-status" role="status" aria-live="polite" aria-atomic="true">${!selected ? "Choose a recorded run when one is available." : state.online ? "Ready to request a bounded read." : "Follow paused while offline. Reconnect before requesting fresh detail."}</p>
<pre id="log-content" tabindex="0" aria-label="Fetched log output"></pre>
<small id="log-fetched">No log content fetched.</small><small id="log-help">Up to 256 KiB per chunk and retained view · read expires after 30 seconds</small></section></div>`;
  return projectDocument("Runs and logs", content, links)
    .replace(
      /\/fleet-assets\/(imgSymbol(?:ChevronRight|Layers[12]?|ShieldCheck))\.svg/g,
      "/fleet-assets/runs/$1.svg"
    )
    .replace(
      "</head>",
      '<link rel="stylesheet" href="/fleet-assets/runs.css"><script defer src="/fleet-assets/runs.js"></script></head>'
    );
}

export const runStyles = `
.shell:has(.run-page) .sidebar nav>.muted{display:flex;align-items:center;gap:10px;min-height:40px;padding:8px;border-radius:6px}
.run-page{display:flex;flex-direction:column;gap:24px;min-width:0}.run-page h2{font-size:18px;line-height:26px;margin:0}.history-panel{display:flex;flex-direction:column;gap:16px;border-bottom:1px solid var(--oms-border-default);padding-bottom:8px}.timeline-item{display:grid;gap:4px;overflow-wrap:anywhere}.timeline-item>a{font-size:12px;color:var(--oms-text-secondary)}.timeline-item time,.run-identity{overflow-wrap:anywhere}.run-pagination{display:flex;align-items:center;gap:16px;flex-wrap:wrap}.log-panel{background:var(--oms-nav-bg);border-bottom:1px solid var(--oms-border-default);padding:20px;border-radius:8px;display:flex;flex-direction:column;gap:16px;min-width:0}.log-toolbar{display:flex;align-items:end;gap:12px 16px;flex-wrap:wrap}.log-toolbar label{display:grid;gap:8px;flex:1;min-width:280px;color:var(--oms-text-secondary);font-size:12px}.log-toolbar select{width:100%;min-width:0;color:var(--oms-text-primary);font-size:13px}.log-toolbar button{min-height:44px}.log-badge{padding:8px;background:var(--oms-info-bg);color:var(--oms-focus);border-radius:4px;font-size:12px;min-height:40px}.log-panel pre{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:13px;line-height:20px;min-height:220px;max-height:60vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;margin:0}.log-panel [hidden]{display:none}.log-panel [role=status]{color:var(--oms-text-secondary)}.log-panel [aria-busy=true]{opacity:.8}
@media(max-width:1199px){.shell:has(.run-page) .sidebar{display:flex;flex-direction:column;align-items:stretch;gap:12px}.shell:has(.run-page) .sidebar .brand{margin:0;font-size:14px;font-weight:400}.shell:has(.run-page) .sidebar img{display:none}.shell:has(.run-page) .sidebar nav{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}}
@media(max-width:650px){.shell:has(.run-page) .sidebar nav>.muted{font-size:11px;padding:4px 8px}.log-toolbar label{min-width:0;flex-basis:100%}.log-toolbar select{max-width:100%}.log-toolbar button{max-width:100%}.run-identity{font-size:11px}.run-page .heading a{font-size:12px}}
`;
