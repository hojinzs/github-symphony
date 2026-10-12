import { request as httpsRequest } from "node:https";
import {
  LIMITS,
  enrollmentRequestSchema,
  enrollmentResponseSchema,
  sessionRequestSchema,
  sessionResponseSchema,
  observationRequestSchema,
  acknowledgmentSchema,
  pollRequestSchema,
  pollResponseSchema,
  claimRequestSchema,
  claimResponseSchema,
  resultRequestSchema,
  errorResponseSchema,
  type AgentControlPlaneClient,
  type Schema,
} from "@gh-symphony/management-protocol";
import type { AgentIdentity } from "./registry.js";

export class AgentTransportError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean
  ) {
    super(`Management transport: ${code}`);
    this.name = "AgentTransportError";
  }
}
export function agentServerOrigin(input: string): string {
  try {
    const url = new URL(input);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      /^https:\/\/[^/?#\\\s]+\/?$/i.test(input)
    )
      return url.origin;
  } catch {
    /* Reject without echoing input. */
  }
  throw new AgentTransportError("invalid_server_origin", false);
}
export interface TransportOptions {
  serverOrigin: string;
  /** Read at request time; credential is never put in a URL. */
  identity: () => AgentIdentity | null;
  signal?: AbortSignal;
  /** Private-network CA trust, never a TLS-verification bypass. */
  ca?: string | Buffer;
  timeoutMs?: number;
}
/** Outbound-only v1 client. Redirects are rejected, so bearer secrets stay at origin. */
export function createAgentTransport(
  options: TransportOptions
): AgentControlPlaneClient {
  const origin = agentServerOrigin(options.serverOrigin);
  const timeoutMs = options.timeoutMs ?? LIMITS.pollTimeoutMs + 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new AgentTransportError("invalid_timeout", false);
  async function exchange<T>(
    path: string,
    input: unknown,
    inputSchema: Schema<unknown>,
    outputSchema: Schema<T>,
    authenticated = true,
    get = false
  ): Promise<T> {
    const payload = inputSchema.parse(input);
    const identity = options.identity();
    if (authenticated && (!identity || identity.serverOrigin !== origin))
      throw new AgentTransportError("identity_required", false);
    const encoded = JSON.stringify(payload);
    if (Buffer.byteLength(encoded) > LIMITS.observationBodyBytes)
      throw new AgentTransportError("request_too_large", false);
    const url = new URL(path, origin);
    if (get) {
      for (const [key, value] of Object.entries(
        payload as Record<string, unknown>
      ))
        url.searchParams.set(key, String(value));
    }
    const raw = await new Promise<unknown>((resolve, reject) => {
      const fail = (code: string, retryable: boolean) =>
        reject(new AgentTransportError(code, retryable));
      const request = httpsRequest(
        url,
        {
          method: get ? "GET" : "POST",
          ca: options.ca,
          signal: options.signal,
          headers: {
            accept: "application/json",
            ...(get
              ? {}
              : {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(encoded),
                }),
            ...(authenticated
              ? { authorization: `Bearer ${identity!.credential}` }
              : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > LIMITS.observationBodyBytes) {
              fail("response_too_large", false);
              response.destroy();
            } else chunks.push(chunk);
          });
          response.on("error", () => fail("network_failure", true));
          response.on("end", () => {
            const status = response.statusCode ?? 0;
            if (status >= 300 && status < 400)
              return fail("redirect_rejected", false);
            let value: unknown;
            try {
              value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              return fail("invalid_response", status >= 500);
            }
            if (status < 200 || status >= 300) {
              let code = "http_failure";
              try {
                code = errorResponseSchema.parse(value).error.code;
              } catch {
                /* Ignore body. */
              }
              return fail(code, status >= 500 || status === 429);
            }
            resolve(value);
          });
        }
      );
      // Absolute deadline, including a peer that trickles bytes indefinitely.
      const timer = setTimeout(() => {
        fail("request_timeout", true);
        request.destroy();
      }, timeoutMs);
      request.once("close", () => clearTimeout(timer));
      request.on("error", () =>
        fail(
          options.signal?.aborted ? "aborted" : "network_failure",
          !options.signal?.aborted
        )
      );
      request.end(get ? undefined : encoded);
    });
    const output = outputSchema.parse(raw);
    const sent = payload as {
      requestId: string;
      environmentId?: string;
      sessionId?: string;
    };
    const received = output as {
      requestId: string;
      environmentId?: string;
      sessionId?: string;
    };
    if (
      received.requestId !== sent.requestId ||
      (sent.environmentId !== undefined &&
        received.environmentId !== sent.environmentId) ||
      (sent.sessionId !== undefined && received.sessionId !== sent.sessionId)
    )
      throw new AgentTransportError("response_identity_mismatch", false);
    return output;
  }
  return {
    enroll: (r) =>
      exchange(
        "/api/v1/agents/enroll",
        r,
        enrollmentRequestSchema,
        enrollmentResponseSchema,
        false
      ),
    openSession: (r) =>
      exchange(
        "/api/v1/agents/sessions",
        r,
        sessionRequestSchema,
        sessionResponseSchema
      ),
    observe: (r) =>
      exchange(
        "/api/v1/agents/observations",
        r,
        observationRequestSchema,
        acknowledgmentSchema
      ),
    poll: (r) =>
      exchange(
        "/api/v1/agents/poll",
        r,
        pollRequestSchema,
        pollResponseSchema,
        true,
        true
      ),
    claim: (r) =>
      exchange(
        `/api/v1/agents/commands/${claimRequestSchema.parse(r).commandId}/claim`,
        r,
        claimRequestSchema,
        claimResponseSchema
      ),
    publishResult: (r) =>
      exchange(
        "/api/v1/agents/results",
        r,
        resultRequestSchema,
        acknowledgmentSchema
      ),
  };
}

/** Saved identity resumes without consuming a second token or changing the allowlist. */
export async function enrollAgent(
  registry: import("./registry.js").AgentRegistry,
  client: Pick<AgentControlPlaneClient, "enroll">,
  serverOrigin: string,
  token: string
): Promise<AgentIdentity> {
  const origin = agentServerOrigin(serverOrigin);
  const saved = registry.identity;
  if (saved) {
    if (saved.serverOrigin !== origin)
      throw new AgentTransportError("identity_server_mismatch", false);
    return saved;
  }
  const { randomUUID } = await import("node:crypto");
  const response = enrollmentResponseSchema.parse(
    await client.enroll({
      protocolVersion: 1,
      requestId: randomUUID(),
      token,
    })
  );
  await registry.saveIdentity(origin, response);
  return registry.identity!;
}
