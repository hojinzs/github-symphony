import { readFileSync } from "node:fs";
import {
  ERROR_HTTP_STATUS,
  createEnvironmentRequestSchema,
  uuidSchema,
} from "@gh-symphony/management-protocol";
import type { BrowserRequest, BrowserSecurity } from "./browser-security.js";
import { resolveHttpsOrigin } from "./config.js";
import { FleetError, type EnrollmentService } from "./enrollment.js";
import {
  environmentDocument,
  environmentRows,
  connectionPanel,
} from "./environment-pages.js";
import { presentEnvironment } from "./environment-presentation.js";
import { environmentStyles } from "./environment-styles.js";
import { environmentBrowserScript } from "./environment-browser.js";
import type { ProjectRouteResponse } from "./project-routes.js";

export interface EnvironmentRouteRequest extends BrowserRequest {
  pathname: string;
  /** Listener supplies bounded JSON with duplicate keys rejected. */
  body?: unknown;
}
export interface EnvironmentRouteOptions {
  publicOrigin: string;
  /** Inventory owner returns known counts only; missing is unknown, not zero. */
  projectCounts(): Promise<ReadonlyMap<string, number>>;
  now?: () => Date;
}
const assets = new Set([
  "imgOhMySymphonyMark",
  "imgSymbolLayers",
  "imgSymbolLayers1",
  "imgSymbolLayers2",
  "imgSymbolShieldCheck",
  "imgSymbolChevronRight",
  "imgRowChevron",
]);
const headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};
function invalid(): never {
  throw new FleetError("invalid_input", "Invalid environment input");
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}

/** Mount only on the private fleet listener. Enrollment/session services own state. */
export function createEnvironmentRoutes(
  enrollment: EnrollmentService,
  browser: BrowserSecurity,
  options: EnvironmentRouteOptions
) {
  const origin = resolveHttpsOrigin(options.publicOrigin);
  const now = options.now ?? (() => new Date());
  const response = (
    status: number,
    body: string,
    extra: Record<string, string> = {}
  ): ProjectRouteResponse => ({
    status,
    body,
    headers: { ...headers, ...extra },
  });
  const json = (status: number, value: unknown) =>
    response(status, JSON.stringify(value));
  return async (
    request: EnvironmentRouteRequest
  ): Promise<ProjectRouteResponse | undefined> => {
    const url = new URL(request.pathname, origin);
    if (request.method === "GET") {
      if (url.pathname === "/fleet-assets/environments.js")
        return response(200, environmentBrowserScript, {
          "Content-Type": "text/javascript; charset=utf-8",
        });
      if (url.pathname === "/fleet-assets/environments.css")
        return response(200, environmentStyles, {
          "Content-Type": "text/css; charset=utf-8",
        });
      const asset = /^\/fleet-assets\/environments\/(\w+)\.svg$/.exec(
        url.pathname
      );
      if (asset && assets.has(asset[1]))
        return response(
          200,
          readFileSync(
            new URL(
              "../assets/environments/" + asset[1] + ".svg",
              import.meta.url
            ),
            "utf8"
          ),
          { "Content-Type": "image/svg+xml" }
        );
    }
    const match =
      /^\/environments\/([^/]+)\/(connection|regenerate|revoke)$/.exec(
        url.pathname
      );
    if (
      !["/environments", "/environments/state"].includes(url.pathname) &&
      !match
    )
      return undefined;
    try {
      if (!["GET", "POST"].includes(request.method))
        return response(405, "", { Allow: "GET, POST" });
      if (
        (request.method === "GET" && match && match[2] !== "connection") ||
        (request.method === "POST" &&
          (url.pathname === "/environments/state" ||
            match?.[2] === "connection"))
      )
        return response(405, "", {
          Allow: request.method === "GET" ? "POST" : "GET",
        });
      let id: string | undefined;
      if (match) {
        try {
          id = uuidSchema.parse(match[1]);
        } catch {
          invalid();
        }
      }
      // Authenticate before parsing any browser-supplied mutation payload.
      if (request.method === "POST") browser.resolveActor(request);
      const counts = await options.projectCounts();
      let issued;
      if (request.method === "POST") {
        const body = object(request.body);
        if (!match) {
          let parsed;
          try {
            parsed = createEnvironmentRequestSchema.parse(body);
          } catch {
            invalid();
          }
          issued = await enrollment.createEnvironment(parsed);
          id = issued.environmentId;
        } else if (match[2] === "regenerate") {
          if (Object.keys(body).length) invalid();
          const record = (await enrollment.listEnvironments()).find(
            (env) => env.environmentId === id
          );
          if (record && record.enrollment !== "pending")
            throw new FleetError(
              "session_conflict",
              "Only pending setup can regenerate a token"
            );
          issued = await enrollment.regenerateEnrollment(id!);
        } else {
          if (Object.keys(body).length !== 1 || body.acknowledged !== true)
            invalid();
          await enrollment.revoke(id!);
        }
      }
      const environments = await enrollment.listEnvironments();
      const rows = environmentRows(environments, counts);
      if (id) {
        const env = environments.find((item) => item.environmentId === id);
        if (!env)
          throw new FleetError("not_found", "Environment does not exist");
        return json(request.method === "POST" && !match ? 201 : 200, {
          environmentId: id,
          stage: presentEnvironment(env, issued, now()).stage,
          rows,
          connection: connectionPanel(env, origin, counts, issued, now()),
        });
      }
      if (url.pathname === "/environments/state") return json(200, { rows });
      const session =
        browser.reuseSession(request.cookie) ?? browser.issueSession();
      return response(200, environmentDocument(rows, session.csrfToken), {
        "Content-Type": "text/html; charset=utf-8",
        "Set-Cookie": session.setCookie,
      });
    } catch (error) {
      const status =
        error instanceof FleetError ? ERROR_HTTP_STATUS[error.code] : 500;
      if (request.method === "GET" && url.pathname === "/environments") {
        const session =
          browser.reuseSession(request.cookie) ?? browser.issueSession();
        return response(
          status,
          environmentDocument(
            '<section role="alert"><h2>Environments unavailable</h2><p>Try again. Saved environments and local execution are preserved.</p><a class="button" href="/environments">Try again</a></section>',
            session.csrfToken
          ),
          {
            "Content-Type": "text/html; charset=utf-8",
            "Set-Cookie": session.setCookie,
          }
        );
      }
      return json(status, {
        error:
          "Unable to update environments. Try again. Saved environments and local execution are preserved.",
      });
    }
  };
}
