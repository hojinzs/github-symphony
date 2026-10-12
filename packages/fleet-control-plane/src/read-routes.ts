import { randomUUID } from "node:crypto";
import {
  ERROR_HTTP_STATUS,
  readSelectionSchema,
} from "@gh-symphony/management-protocol";
import { FleetError } from "./enrollment.js";
import type { BrowserRequest, BrowserSecurity } from "./browser-security.js";
import type { ReadService } from "./reads.js";

export interface ReadRouteRequest extends BrowserRequest {
  pathname: string;
  body?: unknown;
}
export interface ReadRouteResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
}
/** Mount only inside the private fleet listener; no per-project server changes. */
export function createReadRoutes(reads: ReadService, browser: BrowserSecurity) {
  return async (
    request: ReadRouteRequest
  ): Promise<ReadRouteResponse | undefined> => {
    const submit =
      request.method === "POST" &&
      /^\/api\/v1\/projects\/([^/]+)\/reads$/.exec(request.pathname);
    const detail =
      request.method === "GET" &&
      /^\/api\/v1\/reads\/([^/]+)$/.exec(request.pathname);
    if (!submit && !detail) return undefined;
    try {
      if (submit) {
        browser.resolveActor(request);
        let selection;
        try {
          selection = readSelectionSchema.parse(request.body);
        } catch {
          throw new FleetError("invalid_input", "Invalid read selection");
        }
        return {
          status: 202,
          body: await reads.submitRead(submit[1], selection),
        };
      }
      const view = reads.getReadView((detail as RegExpExecArray)[1]);
      return {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "X-Symphony-Historical": String(view.historical),
        },
        body: view.result,
      };
    } catch (error) {
      if (!(error instanceof FleetError)) throw error;
      return {
        status: ERROR_HTTP_STATUS[error.code],
        body: {
          error: {
            code: error.code,
            message: error.message,
            requestId: randomUUID(),
          },
        },
      };
    }
  };
}
