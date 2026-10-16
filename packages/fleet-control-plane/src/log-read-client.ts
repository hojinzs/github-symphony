import {
  LIMITS,
  readResultSchema,
  submitReadResponseSchema,
} from "@gh-symphony/management-protocol";
import { RunLogModel } from "./run-log-model.js";

/** Same-origin C10 transport. One in-flight read; deadline includes submit/poll. */
export class BoundedLogReader {
  private active: AbortController | undefined;
  constructor(
    readonly model: RunLogModel,
    private readonly csrf: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly change: () => void = () => undefined
  ) {}

  disconnect(): void {
    this.model.disconnect();
    this.active?.abort();
    this.change();
  }

  async read(): Promise<void> {
    if (this.active) return;
    const request = this.model.begin();
    if (!request) return;
    const controller = new AbortController();
    this.active = controller;
    let expired = false;
    let readId = crypto.randomUUID() as string;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        expired = true;
        controller.abort();
        reject(new Error("Read expired"));
      }, LIMITS.readLifetimeMs);
    });
    const fetchResponse = async (url: string, init?: RequestInit) => {
      let response: Response;
      try {
        response = await this.fetcher(url, {
          credentials: "same-origin",
          cache: "no-store",
          ...init,
          signal: controller.signal,
        });
      } catch {
        if (!controller.signal.aborted) this.disconnect();
        throw new Error("Connection unavailable");
      }
      if (!response.ok) {
        const body = await response.json().catch(() => undefined);
        if (
          response.status === 502 ||
          response.status === 503 ||
          body?.error?.code === "agent_offline"
        )
          this.disconnect();
        throw new Error("Read unavailable");
      }
      return response;
    };
    const work = async () => {
      const accepted = await fetchResponse(
        "/api/v1/projects/" +
          encodeURIComponent(this.model.identity.projectId) +
          "/reads",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-CSRF-Token": this.csrf,
          },
          body: JSON.stringify(request.selection),
        }
      );
      readId = submitReadResponseSchema.parse(await accepted.json()).readId;
      while (!controller.signal.aborted) {
        const response = await fetchResponse(
          "/api/v1/reads/" + encodeURIComponent(readId)
        );
        const result = readResultSchema.parse(await response.json());
        if (controller.signal.aborted) return;
        if (result.readId !== readId)
          throw new Error("Mismatched read identity");
        this.model.receive(
          request.revision,
          result,
          response.headers.get("X-Symphony-Historical") === "true"
        );
        if (
          result.state === "unavailable" &&
          result.diagnostic.code === "agent_offline"
        )
          this.disconnect();
        if (result.state !== "pending") return;
        await new Promise<void>((resolve) => {
          const abort = () => {
            clearTimeout(wait);
            resolve();
          };
          const wait = setTimeout(() => {
            controller.signal.removeEventListener("abort", abort);
            resolve();
          }, 500);
          controller.signal.addEventListener("abort", abort, { once: true });
        });
      }
    };
    this.change();
    try {
      await Promise.race([work(), deadline]);
    } catch {
      this.model.receive(request.revision, {
        readId,
        state: expired ? "expired" : "unavailable",
        diagnostic: {
          code: "log_unavailable",
          message: expired
            ? "Read expired; request a fresh read."
            : "Log unavailable; request a fresh read when online.",
        },
      });
    } finally {
      clearTimeout(timer);
      controller.abort();
      this.active = undefined;
      this.change();
    }
  }
}
