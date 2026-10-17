import { readFileSync } from "node:fs";
import { LIMITS, uuidSchema } from "@gh-symphony/management-protocol";
import type { EnvironmentRecord } from "@gh-symphony/management-protocol";
import { FleetError } from "./enrollment.js";
import type { ObservationService, ObservedProject } from "./observations.js";
import {
  projectDocument,
  renderFleetPage,
  renderProjectDetail,
  renderProjectFeedback,
  type ProjectLinks,
} from "./project-pages.js";
import { isHistoricalOrStale } from "./project-presentation.js";
import { projectStyles } from "./project-styles.js";

export interface ProjectRouteOptions {
  environments: () => Promise<EnvironmentRecord[]>;
  now?: () => Date;
  /** C17/C18 consumer-owned destinations; never execute commands on GET. */
  links?: ProjectLinks;
}
export interface ProjectRouteResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}
const assets = new Set([
  "imgSymbolChevronRight",
  "imgOhMySymphonyMark",
  "imgSymbolLayers",
  "imgSymbolLayers1",
  "imgSymbolLayers2",
  "imgSymbolShieldCheck",
  "imgSymbolChevronRight1",
  "imgSymbolSearch",
  "imgSymbolChevronDown",
  "imgSymbolSlidersHorizontal",
  "imgStateIndicator",
  "imgSymbolChevronRight2",
  "imgStateIndicator1",
  "imgSymbolClock3",
]);
const script = `document.addEventListener("submit",event=>{if(event.target instanceof HTMLFormElement){document.body.classList.add("busy");document.querySelector("main")?.setAttribute("aria-busy","true");}});window.addEventListener("pageshow",()=>{if(location.hash){document.getElementById(location.hash.slice(1))?.focus();}document.body.classList.remove("busy");document.querySelector("main")?.removeAttribute("aria-busy");});`;
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
function matches(project: ObservedProject, state: string) {
  if (!state) return true;
  if (state === "offline") return project.connection === "offline";
  if (state === "stale") return isHistoricalOrStale(project);
  if (state === "unmanaged") return !project.managed;
  if (state === "invalid")
    return project.observation.validation.state === "invalid";
  if (state === "incompatible")
    return (
      project.observation.validation.state === "invalid" &&
      project.observation.validation.diagnostic.code === "unsupported_protocol"
    );
  // A retained process observation is never a current running/stopped claim.
  return (
    project.managed &&
    project.fresh &&
    project.connection === "online" &&
    project.observation.process.state === state
  );
}
function validId(id: string) {
  try {
    uuidSchema.parse(id);
    return true;
  } catch {
    return false;
  }
}
function validateId(id: string) {
  if (!validId(id)) invalid();
}
function invalid(): never {
  throw new FleetError("invalid_input", "Invalid project page or filters");
}

/** Mount on the private fleet listener only. No login or listener is installed here. */
export function createProjectRoutes(
  observations: ObservationService,
  options: ProjectRouteOptions
) {
  options = {
    ...options,
    links: {
      runs: (id) => "/projects/" + encodeURIComponent(id) + "/runs",
      ...options.links,
    },
  };
  const now = options.now ?? (() => new Date());
  function response(
    status: number,
    body: string,
    type = "text/html; charset=utf-8"
  ): ProjectRouteResponse {
    return {
      status,
      body,
      headers: {
        "Content-Type": type,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        "Referrer-Policy": "no-referrer",
      },
    };
  }
  return async (request: {
    method: string;
    pathname: string;
  }): Promise<ProjectRouteResponse | undefined> => {
    if (request.method !== "GET") return undefined;
    const url = new URL(request.pathname, "https://fleet.invalid");
    if (url.pathname === "/fleet-assets/projects.css")
      return response(200, projectStyles, "text/css; charset=utf-8");
    if (url.pathname === "/fleet-assets/projects.js")
      return response(200, script, "text/javascript; charset=utf-8");
    const asset = /^\/fleet-assets\/(\w+)\.svg$/.exec(url.pathname);
    if (asset && assets.has(asset[1]))
      return response(
        200,
        readFileSync(
          new URL("../assets/" + asset[1] + ".svg", import.meta.url),
          "utf8"
        ),
        "image/svg+xml"
      );
    const detail = /^\/projects\/([^/]+)$/.exec(url.pathname);
    if (url.pathname !== "/projects" && !detail) return undefined;
    try {
      if (detail) {
        validateId(detail[1]);
        const project = await observations.getProject(detail[1]);
        const environments = await options.environments();
        return response(
          200,
          renderProjectDetail(
            project,
            environments.find(
              (env) => env.environmentId === project.environmentId
            )?.name ?? project.environmentId,
            now(),
            options.links
          )
        );
      }
      const params = url.searchParams;
      if (
        [...params.keys()].some(
          (key) =>
            !["q", "state", "environment", "page", "pageSize"].includes(key) ||
            params.getAll(key).length !== 1
        )
      )
        invalid();
      const query = (params.get("q") ?? "").trim();
      const environment = params.get("environment") ?? "";
      const state = params.get("state") ?? "";
      const pageText = params.get("page") ?? "1";
      const sizeText = params.get("pageSize") ?? "25";
      if (
        query.length > 256 ||
        (state && !states.includes(state)) ||
        (environment && !validId(environment)) ||
        !/^[1-9]\d*$/.test(pageText) ||
        !Number.isSafeInteger(Number(pageText)) ||
        !["1", "10", "25", "50"].includes(sizeText)
      )
        invalid();
      // Enumerate C06's cursor contract before applying UI filters so summary,
      // filtered count and Previous/Next pagination all share the same inventory.
      const all: ObservedProject[] = [];
      let cursor: string | undefined;
      do {
        const page = await observations.listProjects({
          limit: LIMITS.maximumPageSize,
          ...(cursor ? { cursor } : {}),
        });
        all.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      const environments = (await options.environments()).map((env) => ({
        id: env.environmentId,
        name: env.name,
      }));
      const items = all.filter(
        (p) =>
          (!environment || p.environmentId === environment) &&
          matches(p, state) &&
          (!query ||
            [
              p.observation.displayName,
              p.localProjectId,
              p.observation.canonicalPath,
              environments.find((env) => env.id === p.environmentId)?.name ??
                p.environmentId,
            ].some((value) =>
              value.toLowerCase().includes(query.toLowerCase())
            ))
      );
      const pageSize = Number(sizeText);
      const page = Math.min(
        Number(pageText),
        Math.max(1, Math.ceil(items.length / pageSize))
      );
      return response(
        200,
        renderFleetPage({
          all,
          items: items.slice((page - 1) * pageSize, page * pageSize),
          total: items.length,
          page,
          pageSize,
          query,
          environment,
          state,
          environments,
          now: now(),
          links: options.links,
        })
      );
    } catch (error) {
      const status =
        error instanceof FleetError
          ? error.code === "not_found"
            ? 404
            : 400
          : 503;
      return response(
        status,
        projectDocument(
          "Projects",
          status === 503
            ? renderProjectFeedback("error", url.pathname + url.search)
            : '<section class="feedback" role="alert"><h1>Project view unavailable</h1><p>Invalid filters or project identity, or no observation exists.</p><a href="/projects">Back to projects</a></section>',
          options.links
        )
      );
    }
  };
}
