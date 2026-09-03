import { spawn } from "node:child_process";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  parseGitCredentialBrokerTimeoutMs,
  resolveGitCredential,
  resolveGitCredentialHelperConfig,
} from "./git-credential-helper.js";

describe("resolveGitCredential", () => {
  it("bounds a hung broker request with an attributable timeout", async () => {
    const brokerUrl = "https://broker.example/runtime-token";
    const fetchImpl = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(init.signal?.reason)
          );
        })
    );

    await expect(
      resolveGitCredential(
        { protocol: "https", host: "github.com" },
        {
          tokenBrokerUrl: brokerUrl,
          tokenBrokerSecret: "runtime-secret",
          tokenBrokerTimeoutMs: 10,
        },
        fetchImpl as typeof fetch
      )
    ).rejects.toMatchObject({
      message: `Git credential token broker request to ${brokerUrl} timed out after 10ms.`,
      cause: expect.objectContaining({ name: "TimeoutError" }),
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("recognizes a timeout wrapped in an error cause", async () => {
    const brokerUrl = "https://broker.example/runtime-token";
    const timeout = new DOMException("request expired", "TimeoutError");

    await expect(
      resolveGitCredential(
        { protocol: "https", host: "github.com" },
        {
          tokenBrokerUrl: brokerUrl,
          tokenBrokerSecret: "runtime-secret",
          tokenBrokerTimeoutMs: 25,
        },
        vi
          .fn()
          .mockRejectedValue(new TypeError("fetch failed", { cause: timeout }))
      )
    ).rejects.toMatchObject({
      message: `Git credential token broker request to ${brokerUrl} timed out after 25ms.`,
    });
  });
});

describe("resolveGitCredentialHelperConfig", () => {
  it("reads the operator-configured broker timeout", () => {
    expect(
      resolveGitCredentialHelperConfig({
        GITHUB_TOKEN_BROKER_TIMEOUT_MS: "7500",
      }).tokenBrokerTimeoutMs
    ).toBe(7500);
  });

  it.each(["", "  "])("treats an empty timeout %j as unset", (timeout) => {
    expect(
      resolveGitCredentialHelperConfig({
        GITHUB_TOKEN_BROKER_TIMEOUT_MS: timeout,
      }).tokenBrokerTimeoutMs
    ).toBeUndefined();
  });

  it.each(["0", "-1", "1.5", "abc", "2147483648"])(
    "rejects invalid timeout %s with an attributable diagnostic",
    (timeout) => {
      expect(() => parseGitCredentialBrokerTimeoutMs(timeout)).toThrow(
        `GITHUB_TOKEN_BROKER_TIMEOUT_MS must be a positive integer no greater than 2147483647; received ${JSON.stringify(timeout)}.`
      );
    }
  );
});

describe("built git credential helper", () => {
  let brokerUrl: string;
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = server.address() as AddressInfo;
    // lvh.me resolves to loopback while exercising the same hostname path as
    // an operator-configured HTTPS broker rather than the rejected IP form.
    brokerUrl = `https://lvh.me:${address.port}/runtime-token`;
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it("terminates a stalled connection at the default deadline", async () => {
    const result = await runBuiltHelper(brokerUrl);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `Git credential token broker request to ${brokerUrl} timed out after 5000ms.`
    );
    expect(result.elapsedMs).toBeLessThan(7_500);
  }, 10_000);

  it("terminates promptly at an operator override", async () => {
    const result = await runBuiltHelper(brokerUrl, "50");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `Git credential token broker request to ${brokerUrl} timed out after 50ms.`
    );
    expect(result.elapsedMs).toBeLessThan(2_000);
  });

  it("rejects a timeout over the timer ceiling before connecting", async () => {
    const result = await runBuiltHelper(brokerUrl, "2147483648");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "GITHUB_TOKEN_BROKER_TIMEOUT_MS must be a positive integer no greater than 2147483647"
    );
    expect(result.elapsedMs).toBeLessThan(2_000);
  });
});

async function runBuiltHelper(
  brokerUrl: string,
  timeoutMs?: string
): Promise<{ exitCode: number | null; stderr: string; elapsedMs: number }> {
  const helperUrl = new URL(
    "../dist/git-credential-helper.js",
    import.meta.url
  );
  const startedAt = Date.now();
  const child = spawn(process.execPath, [helperUrl.pathname], {
    env: {
      ...process.env,
      GITHUB_TOKEN_BROKER_URL: brokerUrl,
      GITHUB_TOKEN_BROKER_SECRET: "runtime-secret",
      GITHUB_TOKEN_BROKER_TIMEOUT_MS: timeoutMs,
    },
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.end("protocol=https\nhost=github.com\n\n");

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const safetyTimer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("built credential helper did not terminate promptly"));
    }, 8_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(safetyTimer);
      resolve(code);
    });
  });

  return { exitCode, stderr, elapsedMs: Date.now() - startedAt };
}
