import type {
  EnvironmentRecord,
  EnrollmentTokenResponse,
} from "@gh-symphony/management-protocol";
import { escapeHtml as e, projectDocument } from "./project-pages.js";
import { presentEnvironment } from "./environment-presentation.js";

export function environmentRows(
  environments: EnvironmentRecord[],
  counts: ReadonlyMap<string, number>
) {
  if (!environments.length)
    return '<section class="feedback"><h2>No environments yet</h2><p>Add an environment to connect a prepared Linux or macOS host.</p></section>';
  const cell = (label: string, value: string) =>
    `<div class="cell"><dt>${label}</dt><dd>${value}</dd></div>`;
  return (
    `<div class="environment-columns" aria-hidden="true"><span>Environment</span><span>Connection</span><span>Host / agent</span><span>Projects</span><span>Last contact</span><span></span></div>` +
    environments
      .map((env) => {
        const view = presentEnvironment(env);
        const count = counts.get(env.environmentId);
        return `<article class="environment-row"><a id="environment-${e(env.environmentId)}" class="environment-name" data-connect="${e(env.environmentId)}" href="/environments/${e(env.environmentId)}/connection">${e(env.name)}</a><dl>${cell("Connection", `<span class="${view.stage === "online" ? "online" : view.stage === "offline" ? "offline" : ""}">${e(view.label)}</span>`)}${cell("Host / agent", env.host ? `${e(env.host.hostname)}<small>${env.host.os === "darwin" ? "macOS" : "Linux"} · ${e(env.agentVersion ?? "Version not reported")}</small>` : "Not reported yet")}${cell("Projects", env.enrollment !== "pending" && count !== undefined ? `${count} projects` : "—")}${cell("Last contact", env.lastContactAt ? `<time datetime="${e(env.lastContactAt)}">${e(env.lastContactAt)}</time>` : "No signal received")}</dl><img alt="" src="/fleet-assets/environments/imgRowChevron.svg"></article>`;
      })
      .join("")
  );
}

export function connectionPanel(
  env: EnvironmentRecord,
  origin: string,
  counts: ReadonlyMap<string, number>,
  issued?: EnrollmentTokenResponse,
  now = new Date()
) {
  const command =
    "gh-symphony agent setup --server '" + origin.replace(/'/g, "'\\''") + "'";
  const view = presentEnvironment(env, issued, now);
  const count = counts.get(env.environmentId);
  const copy = (id: string, label: string) =>
    `<button type="button" data-copy="${id}">${label}</button>`;
  const setup = view.stage === "token-ready" || view.canResume;
  return `<section data-stage="${view.stage}" data-environment="${e(env.environmentId)}"><h2 id="connection-title" tabindex="-1">Connect ${e(env.name)}</h2><p class="muted">The saved environment remains available when this panel is closed.</p>${["pending", "token-ready", "awaiting-signal"].includes(view.stage) ? '<p class="muted" data-wait-elapsed>Waiting 0s for the host</p>' : ""}<div class="notice" role="status"><strong>${e(view.label)}</strong><p>${e(view.explanation)}</p></div>${setup ? `<section class="setup-panel">${!view.canResume ? `<label>Host operating system<select data-host-os><option value="linux"${env.host?.os === "linux" ? " selected" : ""}>Linux</option><option value="darwin"${env.host?.os === "darwin" ? " selected" : ""}>macOS</option></select></label><p data-os-help>Linux: current-user systemd; boot/logout requires linger and may need local authorization. macOS: user LaunchAgent starts at login; no pre-login or logout-survival promise.</p><label>Configured server<input readonly tabindex="-1" value="${e(origin)}"></label>` : ""}<code id="setup-command">${e(command)}</code>${copy("setup-command", view.canResume ? "Copy resume command" : "Copy setup command")}${view.canResume ? '<p class="muted">Resume service installation on the host. Do not request another token. Check local service status, HTTPS/private CA and reachability.</p>' : ""}${view.token ? `<label>Enrollment token (read only)<textarea id="enrollment-token" readonly aria-describedby="token-selection-hint">${e(view.token)}</textarea></label><small id="token-selection-hint">Select this field and use Ctrl+A / Command+A to select the token, then copy manually if needed.</small>${copy("enrollment-token", "Copy token")}<p>Paste the token into the hidden terminal prompt. Never put it in command arguments.</p><p data-expiry="${e(view.expiresAt)}">Expires at ${e(view.expiresAt)} · single use · ten minutes</p>` : ""}</section>` : ""}${view.canRegenerate ? '<form data-action="regenerate"><button type="submit">Generate new token</button><small>Replaces the previous unused token for this saved environment.</small></form>' : ""}${view.stage === "online" ? `<div class="connection-card"><p>Connection successful${count === 0 ? " · No projects yet" : ""}.</p><p>${count === undefined ? "Project inventory has not been reported." : `${count} projects reported.`}</p><p>Register a prepared folder locally:</p><code>gh-symphony agent project add &lt;prepared-folder&gt;</code><a href="/projects?environment=${e(env.environmentId)}">View projects</a></div>` : ""}${env.enrollment === "enrolled" ? '<details><summary>Revoke agent access</summary><p>Ends management access. Local execution continues.</p><form data-action="revoke"><label><input type="checkbox" name="acknowledged" required> I understand local execution continues</label><button class="destructive" type="submit">Revoke agent access</button></form></details>' : ""}<button type="button" data-close>Close and keep environment</button></section>`;
}

export function environmentDocument(rows: string, csrfToken: string) {
  const content = `<div class="environment-heading"><h1>Environments</h1><p class="muted">Manage the hosts that run your projects.</p></div><div><button class="primary" id="add-environment" type="button" data-add>Add environment</button></div><div id="environment-list">${rows}</div><p id="environment-status" role="status" aria-live="polite"></p><button type="button" data-retry hidden>Try again</button><dialog id="connection-dialog" aria-labelledby="connection-title" data-csrf="${e(csrfToken)}"><div id="connection-content"></div><p id="connection-feedback" role="status" aria-live="polite"></p><button type="button" data-retry hidden>Try again</button></dialog><template id="create-environment"><section><h2 id="connection-title">Add environment</h2><p class="muted">Name this host. Setup happens in its terminal.</p><form data-action="create"><label>Environment name<input name="name" aria-describedby="connection-feedback" maxlength="120" required autocomplete="off"></label><button class="primary" type="submit">Create environment</button></form><button type="button" data-close>Cancel</button></section></template><noscript>Enable JavaScript to connect an environment. Closing keeps saved environments.</noscript>`;
  return projectDocument(
    "Environments",
    content,
    {},
    "environments"
  ).replaceAll("/fleet-assets/img", "/fleet-assets/environments/img");
}
