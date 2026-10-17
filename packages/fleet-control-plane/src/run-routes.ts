import { readFileSync } from "node:fs";
import {
  LOG_STREAMS,
  uuidSchema,
  type LogStream,
} from "@gh-symphony/management-protocol";
import type { BrowserSecurity, BrowserSession } from "./browser-security.js";
import type { ObservationService } from "./observations.js";
import type {
  ProjectRouteOptions,
  ProjectRouteResponse,
} from "./project-routes.js";
import { FleetError } from "./enrollment.js";
import { projectDocument } from "./project-pages.js";
import { renderRunPage, runPageState, runStyles } from "./run-pages.js";

/** Mount beside C16/C10 on the private fleet listener. No mutations on GET. */
export function createRunRoutes(
  observations: Pick<ObservationService, "getProject">,
  browser: BrowserSecurity,
  options: ProjectRouteOptions
) {
  // Share a session across navigation until renewal is due. A tab holding an
  // older CSRF token receives explicit reload guidance from the log reader.
  let pageSession: BrowserSession | undefined;
  const assets = new Map<string, string>();
  function readAsset(path: string): string {
    let content = assets.get(path);
    if (content === undefined) {
      content = readFileSync(new URL(path, import.meta.url), "utf8");
      assets.set(path, content);
    }
    return content;
  }
  let renewAt = 0;
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
          "default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
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
    if (url.pathname === "/fleet-assets/runs.css")
      return response(200, runStyles, "text/css; charset=utf-8");
    if (url.pathname === "/fleet-assets/runs.js")
      return response(
        200,
        readAsset("./browser/run-log-client.js"),
        "text/javascript; charset=utf-8"
      );
    const asset =
      /^\/fleet-assets\/runs\/(imgSymbol(?:ChevronRight|Layers[12]?|ShieldCheck))\.svg$/.exec(
        url.pathname
      );
    if (asset)
      return response(
        200,
        readAsset("../assets/runs/" + asset[1] + ".svg"),
        "image/svg+xml"
      );
    const match = /^\/projects\/([^/]+)\/runs(\/state)?$/.exec(url.pathname);
    if (!match) return undefined;
    try {
      try {
        uuidSchema.parse(match[1]);
      } catch {
        throw new FleetError("invalid_input", "Invalid project identity");
      }
      const project = await observations.getProject(match[1]);
      const params = url.searchParams;
      const runId = params.get("run") ?? undefined;
      const stream = params.get("stream") ?? "worker";
      const page = params.get("page") ?? "1";
      if (
        [...params.keys()].some(
          (key) =>
            !["run", "stream", "page"].includes(key) ||
            params.getAll(key).length !== 1
        ) ||
        !LOG_STREAMS.includes(stream as LogStream) ||
        !/^[1-9]\d*$/.test(page) ||
        !Number.isSafeInteger(Number(page)) ||
        (runId !== undefined &&
          !project.observation.runs.some((run) => run.runId === runId))
      )
        throw new FleetError(
          "invalid_input",
          "Invalid run or stream selection"
        );
      if (match[2])
        return response(
          200,
          JSON.stringify(runPageState(project)),
          "application/json; charset=utf-8"
        );
      const environments = await options.environments();
      const now = (options.now?.() ?? new Date()).getTime();
      if (!pageSession || now >= renewAt) {
        pageSession = browser.issueSession();
        // Renew halfway through the actual session lifetime. Existing tabs
        // retain their CSRF token and can reload if the shared cookie rotates.
        renewAt = now + (Date.parse(pageSession.expiresAt) - now) / 2;
      }
      const session = pageSession;
      const result = response(
        200,
        renderRunPage(
          project,
          environments.find(
            (env) => env.environmentId === project.environmentId
          )?.name ?? project.environmentId,
          {
            page: Number(page),
            runId,
            stream: stream as LogStream,
            csrfToken: session.csrfToken,
          },
          options.links
        )
      );
      result.headers["Set-Cookie"] = session.setCookie.replace(
        /Max-Age=\d+/,
        "Max-Age=" +
          Math.max(0, Math.floor((Date.parse(session.expiresAt) - now) / 1000))
      );
      return result;
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
          "Runs and logs",
          '<section class="feedback" role="alert"><h1>Run history unavailable</h1><p>Project, run or stream selection is unavailable. Return to the project to refresh known runs.</p><a href="/projects">Back to projects</a></section>',
          options.links
        )
      );
    }
  };
}
