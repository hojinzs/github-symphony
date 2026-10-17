import type { ObservedProject } from "./observations.js";
import {
  presentProject,
  summarizeProjects,
  type ProjectPresentation,
} from "./project-presentation.js";

export function escapeHtml(value: unknown): string {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ]!
  );
}
const e = escapeHtml;
const icon = (name: string) => `<img alt="" src="/fleet-assets/${name}.svg">`;
export interface ProjectLinks {
  environments?: string;
  commands?: (projectId: string) => string;
  runs?: (projectId: string) => string;
  start?: (projectId: string) => string;
  stop?: (projectId: string) => string;
}
function localLink(value: string | undefined): string | undefined {
  return value?.startsWith("/") &&
    !value.startsWith("//") &&
    !/[\\\r\n]/.test(value)
    ? value
    : undefined;
}
function link(value: string | undefined, label: string, classes = "") {
  const safe = localLink(value);
  return safe
    ? `<a class="${classes}" href="${e(safe)}">${label}</a>`
    : `<span class="muted">${label}</span>`;
}
export function projectDocument(
  title: string,
  content: string,
  links: ProjectLinks = {}
) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(title)} · OhMySymphony</title><link rel="stylesheet" href="/fleet-assets/projects.css"><script defer src="/fleet-assets/projects.js"></script></head><body><a class="skip" href="#main">Skip to content</a><div class="shell"><aside class="sidebar"><a class="brand" href="/projects">${icon("imgOhMySymphonyMark")}OhMySymphony</a><span class="muted">WORKSPACE</span><nav aria-label="Workspace"><a class="nav-item" aria-current="page" href="/projects">${icon("imgSymbolLayers")}Projects</a>${link(links.environments, icon("imgSymbolLayers1") + "Environments", "nav-item")}<span class="nav-item">${icon("imgSymbolLayers2")}Commands</span></nav><div class="private"><small>${icon("imgSymbolShieldCheck")} Private network</small><small>Single operator</small></div></aside><div><header class="location">Workspace ${icon("imgSymbolChevronRight")} ${e(title)}<small>Private workspace</small></header><p class="loading notice" role="status">Loading project observations…</p><main id="main">${content}<small>Private workspace · Single operator</small></main></div></div></body></html>`;
}
function notice(body: string, warning = false) {
  return `<p class="notice${warning ? " warning" : ""}">${e(body)}</p>`;
}
export function renderProjectFeedback(
  state: "loading" | "error" | "empty",
  retry = "/projects"
) {
  if (state === "loading")
    return '<section class="feedback" role="status" aria-busy="true"><h1>Loading projects</h1><p>Waiting for project observations…</p></section>';
  if (state === "error")
    return `<section class="feedback" role="alert"><h1>Projects unavailable</h1><p>Unable to load observations. Existing project processes are unaffected.</p>${link(retry, "Try again", "button")}</section>`;
  return '<section class="feedback"><h2>No projects yet</h2><p>Register a prepared folder locally with the management agent. Project provisioning is unavailable here.</p></section>';
}
function observed(time: string, now: Date, historical: boolean) {
  const seconds = Math.max(
    0,
    Math.floor((now.getTime() - Date.parse(time)) / 1000)
  );
  const age = Number.isFinite(seconds)
    ? seconds < 60
      ? `${seconds}s ago`
      : `${Math.floor(seconds / 60)}m ago`
    : "Age unknown";
  return `<time class="observed" datetime="${e(time)}">${e(/^\d{4}-\d{2}-\d{2}T/.test(time) ? time.slice(11, 19) : time)}</time><small>${age}${historical ? " · historical" : ""}</small>`;
}
function cell(label: string, value: string, classes = "") {
  return `<div class="cell ${classes}"><dt>${label}</dt><dd>${value}</dd></div>`;
}
function work(p: ProjectPresentation) {
  return `${p.activeWork === undefined ? "Unknown work" : `${p.activeWork} active`}${p.snapshotHistorical ? " · historical" : ""}<small>${p.retrying === undefined ? "Retries unknown" : `${p.retrying} retrying`}</small>`;
}
export function projectRow(
  p: ProjectPresentation,
  environment: string,
  now: Date
) {
  const path = "/projects/" + encodeURIComponent(p.projectId);
  return `<article class="row"><div class="identity"><span class="monogram">${e(p.name.slice(0, 2).toUpperCase())}</span><div><a href="${e(path)}">${e(p.name)}</a><small>${e(p.localProjectId)}</small><small class="environment-inline">${e(environment)}</small></div></div><dl>${cell("Environment", e(environment), "environment")}${cell("Connection", `<span class="connection ${p.connection}">${icon(p.connection === "online" ? "imgStateIndicator" : "imgStateIndicator1")}${p.connection === "online" ? "Online" : "Offline"}</span>`)}${cell("Process", `${p.historical ? "Last known " : ""}${e(p.process)}`)}${cell("Work", work(p))}${cell("Observed", observed(p.observedAt, now, p.historical))}</dl><a class="row-link" href="${e(path)}" aria-label="Open ${e(p.name)} on ${e(environment)}">${icon("imgSymbolChevronRight2")}</a></article>`;
}
export interface FleetPage {
  all: ObservedProject[];
  items: ObservedProject[];
  total: number;
  page: number;
  pageSize: number;
  query: string;
  environment: string;
  state: string;
  environments: { id: string; name: string }[];
  now: Date;
  links?: ProjectLinks;
}
export function renderFleetPage(page: FleetPage) {
  const summary = summarizeProjects(page.all);
  const environmentName = (id: string) =>
    page.environments.find((env) => env.id === id)?.name ?? id;
  function options(
    values: { value: string; label: string }[],
    selected: string
  ) {
    return values
      .map(
        ({ value, label }) =>
          `<option value="${e(value)}"${selected === value ? " selected" : ""}>${e(label)}</option>`
      )
      .join("");
  }
  const states = [
    "running",
    "stopped",
    "unknown",
    "offline",
    "stale",
    "invalid",
    "unmanaged",
    "incompatible",
  ];
  const href = (number: number) =>
    "/projects?" +
    new URLSearchParams({
      q: page.query,
      environment: page.environment,
      state: page.state,
      pageSize: String(page.pageSize),
      page: String(number),
    });
  const first = page.total ? (page.page - 1) * page.pageSize + 1 : 0;
  return projectDocument(
    "Projects",
    `<div class="heading"><div><h1>Projects</h1><small>${page.all.length} projects across ${new Set(page.all.map((p) => p.environmentId)).size} environments</small></div>${link(page.links?.environments, `View environments ${icon("imgSymbolChevronRight1")}`, "button primary")}</div><section aria-label="Workspace summary"><div class="metrics"><p><strong>${summary.running}</strong> Running<small>Fresh observations</small></p><p><strong>${summary.activeWork}</strong> Active runs<small>Fresh running projects only</small></p><p><strong>${summary.historical}</strong> Offline / stale projects<small>All inventory · includes unmanaged</small></p></div><small class="snapshot-age">${summary.scope} · As of ${e(page.now.toISOString())} · ${summary.unknownWork} projects with unknown or historical work</small></section>${[...new Set(page.all.flatMap((p) => presentProject(p).warnings))].map((w) => notice(w, true)).join("")}<section aria-label="Projects inventory"><form class="toolbar" action="/projects" method="get"><label>Search projects<span class="search-input">${icon("imgSymbolSearch")}<input name="q" type="search" value="${e(page.query)}" placeholder="Search projects…"></span></label><label>Environment<span class="select-input"><select name="environment">${options([{ value: "", label: "All environments" }, ...page.environments.map((env) => ({ value: env.id, label: env.name }))], page.environment)}</select>${icon("imgSymbolChevronDown")}</span></label><label>State<span class="select-input"><select name="state">${options([{ value: "", label: "All states" }, ...states.map((value) => ({ value, label: value }))], page.state)}</select>${icon("imgSymbolChevronDown")}</span></label><label><span>${icon("imgSymbolSlidersHorizontal")} Display</span><select name="pageSize">${options(
      [1, 10, 25, 50].map((value) => ({
        value: String(value),
        label: String(value) + " per page",
      })),
      String(page.pageSize)
    )}</select></label><button type="submit">Apply filters</button><a href="/projects">Clear filters</a></form><div class="column-head" aria-hidden="true"><span>Project</span><span class="environment">Environment</span><span>Connection</span><span>Process</span><span>Work</span><span>Last observed</span><span></span></div>${page.items.map((p) => projectRow(presentProject(p), environmentName(p.environmentId), page.now)).join("") || (page.all.length ? '<section class="feedback"><h2>No matching projects</h2><p>Clear or change filters to see more projects.</p></section>' : renderProjectFeedback("empty"))}<div class="footer" aria-label="Pagination"><small role="status">${first}–${Math.min(page.page * page.pageSize, page.total)} of ${page.total} projects</small>${page.page > 1 ? link(href(page.page - 1), "Previous", "button") : ""}${page.page * page.pageSize < page.total ? link(href(page.page + 1), "Next", "button") : ""}<small class="muted">${icon("imgSymbolClock3")} Offline observations are excluded from running and work totals.</small></div></section>${link(href(page.page), "Refresh observations", "button")}`,
    page.links
  );
}
function action(
  p: ProjectPresentation,
  kind: "start" | "stop",
  links: ProjectLinks
) {
  const reason = kind === "start" ? p.startReason : p.stopReason;
  const destination = localLink(links[kind]?.(p.projectId));
  const disabledReason =
    reason ??
    (!destination
      ? "Lifecycle actions are not connected to this view."
      : undefined);
  const label = kind === "start" ? "Start project" : "Stop project";
  return `<div id="${kind}-action" tabindex="-1">${disabledReason ? `<button disabled aria-describedby="${kind}-reason">${label}</button><small id="${kind}-reason">${e(disabledReason)}</small>` : link(destination, label, "button" + (kind === "stop" ? " destructive" : ""))}</div>`;
}
export function renderProjectDetail(
  project: ObservedProject,
  environment: string,
  now: Date,
  links: ProjectLinks = {}
) {
  const p = presentProject(project);
  return projectDocument(
    "Project detail",
    `${link("/projects", "Back to projects")}<small>Observation view as of ${e(now.toISOString())}</small><div class="heading"><div><h1>${e(p.name)}</h1><small>${e(environment)} · ${e(p.localProjectId)} · Project observations</small></div><div class="actions">${action(p, "start", links)}${action(p, "stop", links)}</div></div><dl class="detail-metrics">${cell("Connection", p.connection === "online" ? "Online" : "Offline")}${cell("Process", `${p.historical ? "Last known " : ""}${e(p.process)}`)}${cell("Health", `${e(p.health)}${p.snapshotHistorical ? " · historical" : ""}`)}${cell("Last observed", observed(p.observedAt, now, p.historical))}</dl><p class="path">${e(p.path)}</p>${p.historical ? notice("Historical observations. Disconnect does not mean stopped; existing execution continues independently.", true) : ""}${p.validation ? notice("Workflow validation: " + p.validation, true) : ""}${p.warnings.map((w) => notice(w, true)).join("")}<nav class="tabs" aria-label="Project sections"><a href="#overview" aria-current="page">Overview</a>${link(links.runs?.(p.projectId), "Runs &amp; logs")}${link(links.commands?.(p.projectId), "Commands")}</nav><section id="overview" class="detail-grid"><div><h2>Work observations</h2><p>${work(p)}</p><small>Snapshot observed: ${e(p.snapshotObservedAt ?? "Not available")}</small><p class="notice">Work retry remains owned by the project orchestrator.</p></div><div><h2>Runtime detail</h2><dl>${cell("Process observed", e(p.processObservedAt))}${cell("Last received", e(p.receivedAt))}${cell("CLI version", e(project.observation.cliVersion))}</dl><small>Last received is the fleet receipt time. Agent timestamps are retained separately.</small></div></section>${link("/projects/" + encodeURIComponent(p.projectId), "Refresh observations", "button")}`,
    links
  );
}
