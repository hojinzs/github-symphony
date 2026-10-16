import { commandBrowserScript } from "./command-browser.js";
import { randomUUID } from "node:crypto";
import {
  ERROR_HTTP_STATUS,
  closeUnresolvedRequestSchema,
  pageRequestSchema,
  submitCommandRequestSchema,
  uuidSchema,
  type LifecycleOperation,
  type Schema,
} from "@gh-symphony/management-protocol";
import type { BrowserRequest, BrowserSecurity } from "./browser-security.js";
import type { CommandService } from "./commands.js";
import { FleetError } from "./enrollment.js";
import {
  renderClosureConfirmation,
  renderCommandConfirmation,
  renderCommandDetail,
  renderCommandHistory,
  type CommandContext,
} from "./command-pages.js";
import {
  escapeHtml,
  projectDocument,
  type ProjectLinks,
} from "./project-pages.js";
import type { ProjectRouteResponse } from "./project-routes.js";
import { presentProject } from "./project-presentation.js";

export interface CommandRouteRequest extends BrowserRequest {
  pathname: string;
  /** Listener parses a bounded form body, rejecting duplicate field names. */
  body?: unknown;
}
export interface CommandRouteOptions {
  /** C06 observation plus service-owned eligibility; never browser-supplied. */
  context(projectId: string): Promise<CommandContext>;
  now?: () => number;
}
export const commandProjectLinks: ProjectLinks = {
  commands: (id) => `/projects/${encodeURIComponent(id)}/commands`,
  start: (id) => `/projects/${encodeURIComponent(id)}/commands/start`,
  stop: (id) => `/projects/${encodeURIComponent(id)}/commands/stop`,
};
function parse<T>(schema: Schema<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch {
    throw new FleetError("invalid_input", "Invalid command form");
  }
}
function fields(value: unknown, keys: string[]): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const entries = Object.entries(value);
  if (
    entries.some(
      ([key, item]) =>
        !keys.includes(key) || typeof item !== "string" || item.length > 8192
    )
  )
    invalid();
  return Object.fromEntries(entries) as Record<string, string>;
}
function invalid(): never {
  throw new FleetError(
    "invalid_input",
    "Invalid command form. Review the input and confirm again."
  );
}
const headers = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'none'; img-src 'self'; style-src 'self'; script-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};
/** Private fleet mount only. C07 owns persistence/admission; this is not a queue. */
export function createCommandRoutes(
  commands: CommandService,
  browser: BrowserSecurity,
  options: CommandRouteOptions
) {
  const now = options.now ?? Date.now;
  // Short-lived review receipts enforce the separate unknown-closure confirmation.
  // They contain no execution intent and disappear safely on service restart.
  const reviews = new Map<
    string,
    {
      commandId: string;
      reason: string;
      csrf: string;
      cookie: BrowserRequest["cookie"];
      expires: number;
    }
  >();
  const response = (
    status: number,
    body: string,
    extra: Record<string, string> = {}
  ): ProjectRouteResponse => ({
    status,
    body,
    headers: { ...headers, ...extra },
  });
  const redirect = (id: string) =>
    response(303, "", { Location: `/commands/${id}` });
  return async (
    request: CommandRouteRequest
  ): Promise<ProjectRouteResponse | undefined> => {
    const url = new URL(request.pathname, "https://fleet.invalid");
    if (
      request.method === "GET" &&
      url.pathname === "/fleet-assets/commands.js"
    )
      return response(200, commandBrowserScript, {
        "Content-Type": "text/javascript; charset=utf-8",
      });
    const projectMatch =
      /^\/projects\/([^/]+)\/commands(?:\/(start|stop))?$/.exec(url.pathname);
    const commandMatch =
      /^\/commands\/([^/]+)(?:\/(closure-confirmation|close-unresolved))?$/.exec(
        url.pathname
      );
    if (!projectMatch && !commandMatch) return undefined;
    try {
      const id = parse(uuidSchema, (projectMatch ?? commandMatch)![1]);
      if (!["GET", "POST"].includes(request.method))
        return response(405, "", { Allow: "GET, POST" });
      if (request.method === "GET") {
        if (commandMatch?.[2]) invalid();
        if (projectMatch && !projectMatch[2]) {
          if (
            [...url.searchParams.keys()].some(
              (key) =>
                key !== "cursor" || url.searchParams.getAll(key).length !== 1
            )
          )
            invalid();
          const page = parse(pageRequestSchema, {
            limit: 25,
            ...(url.searchParams.has("cursor")
              ? { cursor: url.searchParams.get("cursor") }
              : {}),
          });
          return response(
            200,
            renderCommandHistory(
              await options.context(id),
              await commands.listCommands(id, page)
            )
          );
        }
        if (url.search) invalid();
        const session = browser.issueSession();
        const extra = { "Set-Cookie": session.setCookie };
        if (projectMatch)
          return response(
            200,
            renderCommandConfirmation(
              await options.context(id),
              projectMatch[2] as LifecycleOperation,
              { csrf: session.csrfToken, idempotencyKey: randomUUID() }
            ),
            extra
          );
        const command = await commands.getCommand(id);
        return response(
          200,
          renderCommandDetail(
            await options.context(command.projectId),
            command,
            session.csrfToken
          ),
          extra
        );
      }
      if (url.search || projectMatch?.[2]) invalid();
      const body = fields(
        request.body,
        projectMatch
          ? ["csrf", "operation", "idempotencyKey"]
          : commandMatch?.[2] === "closure-confirmation"
            ? ["csrf", "reason"]
            : ["csrf", "reason", "acknowledge", "review"]
      );
      browser.resolveActor({ ...request, csrfToken: body.csrf });
      if (projectMatch) {
        const selection = parse(submitCommandRequestSchema, {
          operation: body.operation,
        });
        const context = await options.context(id);
        const p = presentProject(context.project);
        const reason =
          context.disabledReasons[selection.operation] ??
          (selection.operation === "start" ? p.startReason : p.stopReason);
        if (reason) throw new FleetError("process_unverified", reason);
        // The durable service preserves idempotency and rechecks backend admission.
        const submitted = await commands.submitCommand(
          id,
          body.idempotencyKey,
          selection
        );
        return redirect(submitted.commandId);
      }
      const command = await commands.getCommand(id);
      if (!commandMatch?.[2] || command.state !== "unknown" || command.closure)
        invalid();
      const closure = parse(closeUnresolvedRequestSchema, {
        reason: body.reason,
        acknowledged: true,
      });
      if (commandMatch[2] === "closure-confirmation") {
        for (const [key, value] of reviews)
          if (value.expires <= now()) reviews.delete(key);
        if (reviews.size >= 256) reviews.delete(reviews.keys().next().value!);
        const review = randomUUID();
        reviews.set(review, {
          commandId: id,
          reason: closure.reason,
          csrf: body.csrf,
          cookie: request.cookie,
          expires: now() + 300_000,
        });
        return response(
          200,
          renderClosureConfirmation(command, closure.reason, body.csrf, review)
        );
      }
      const review = reviews.get(body.review);
      if (
        !review ||
        review.commandId !== id ||
        review.reason !== closure.reason ||
        review.csrf !== body.csrf ||
        review.cookie !== request.cookie ||
        review.expires <= now() ||
        body.acknowledge !== "true"
      )
        invalid();
      await commands.closeUnresolved(id, closure);
      reviews.delete(body.review);
      return redirect(id);
    } catch (error) {
      const known = error instanceof FleetError;
      const status = known ? ERROR_HTTP_STATUS[error.code] : 503;
      return response(
        status,
        projectDocument(
          "Command unavailable",
          `<section role="alert" tabindex="-1" class="feedback"><h1>Command unavailable</h1><p>${known ? escapeHtml(error.code + ": " + error.message) : "Unable to verify the command response. Inspect command history before submitting any new intent."}</p><p>No process-state change is inferred from this response.</p><a href="/projects">Back to projects</a>${projectMatch ? `<a href="/projects/${escapeHtml(projectMatch[1])}/commands">Inspect command history</a>` : ""}</section>`
        )
      );
    }
  };
}
