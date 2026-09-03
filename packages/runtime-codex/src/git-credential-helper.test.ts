import { describe, expect, it, vi } from "vitest";
import {
  formatGitCredentialResponse,
  parseGitCredentialRequest,
  resolveGitCredentialHelperConfig,
  resolveGitCredential,
} from "./git-credential-helper.js";

describe("parseGitCredentialRequest", () => {
  it("parses git credential key-value input", () => {
    expect(
      parseGitCredentialRequest(
        "protocol=https\nhost=github.com\npath=acme/platform.git\n"
      )
    ).toEqual({
      protocol: "https",
      host: "github.com",
      path: "acme/platform.git",
    });
  });
});

describe("formatGitCredentialResponse", () => {
  it("renders git credential output with the trailing separator line", () => {
    expect(
      formatGitCredentialResponse({
        username: "x-access-token",
        password: "ghs_token",
      })
    ).toBe("username=x-access-token\npassword=ghs_token\n\n");
  });
});

describe("resolveGitCredential", () => {
  it("returns a brokered credential for github.com over https", async () => {
    const response = await resolveGitCredential(
      {
        protocol: "https",
        host: "github.com",
      },
      {
        tokenBrokerUrl: "https://broker.example/runtime-token",
        tokenBrokerSecret: "runtime-secret",
        tokenCachePath: "/tmp/github-token-cache.json",
      },
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            token: "ghs_brokered",
            expiresAt: "2026-03-07T10:20:00.000Z",
          }),
          { status: 200 }
        )
      ) as never
    );

    expect(response).toContain("username=x-access-token");
    expect(response).toContain("password=ghs_brokered");
  });

  it("bounds a hung broker request with an attributable timeout", async () => {
    const brokerUrl = "https://broker.example/runtime-token";
    const fetchImpl = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason);
          });
        })
    );

    const result = resolveGitCredential(
      {
        protocol: "https",
        host: "github.com",
      },
      {
        tokenBrokerUrl: brokerUrl,
        tokenBrokerSecret: "runtime-secret",
        tokenBrokerTimeoutMs: 10,
      },
      fetchImpl as typeof fetch
    );

    await expect(result).rejects.toMatchObject({
      message: `Git credential token broker request to ${brokerUrl} timed out after 10ms.`,
      cause: expect.objectContaining({ name: "TimeoutError" }),
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("recognizes a broker timeout wrapped in an error cause", async () => {
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
      cause: expect.objectContaining({ message: "fetch failed" }),
    });
  });

  it("preserves non-timeout broker errors", async () => {
    const brokerError = new Error("broker returned 500");

    await expect(
      resolveGitCredential(
        { protocol: "https", host: "github.com" },
        {
          tokenBrokerUrl: "https://broker.example/runtime-token",
          tokenBrokerSecret: "runtime-secret",
        },
        vi.fn().mockRejectedValue(brokerError)
      )
    ).rejects.toBe(brokerError);
  });

  it("ignores unsupported hosts or protocols", async () => {
    await expect(
      resolveGitCredential(
        {
          protocol: "ssh",
          host: "github.com",
        },
        {
          token: "ghs_static",
        }
      )
    ).resolves.toBe("");

    await expect(
      resolveGitCredential(
        {
          protocol: "https",
          host: "example.com",
        },
        {
          token: "ghs_static",
        }
      )
    ).resolves.toBe("");
  });
});

describe("resolveGitCredentialHelperConfig", () => {
  it("reads the operator-configured broker timeout from the helper environment", () => {
    expect(
      resolveGitCredentialHelperConfig({
        GITHUB_TOKEN_BROKER_URL: "https://broker.example/runtime-token",
        GITHUB_TOKEN_BROKER_SECRET: "runtime-secret",
        GITHUB_TOKEN_BROKER_TIMEOUT_MS: "7500",
      })
    ).toMatchObject({
      tokenBrokerUrl: "https://broker.example/runtime-token",
      tokenBrokerSecret: "runtime-secret",
      tokenBrokerTimeoutMs: 7500,
    });
  });

  it.each(["0", "-1", "1.5", "abc", "2147483648"])(
    "rejects invalid operator broker timeout %s with an attributable diagnostic",
    (timeout) => {
      expect(() =>
        resolveGitCredentialHelperConfig({
          GITHUB_TOKEN_BROKER_TIMEOUT_MS: timeout,
        })
      ).toThrow(
        `GITHUB_TOKEN_BROKER_TIMEOUT_MS must be a positive integer no greater than 2147483647; received ${JSON.stringify(timeout)}.`
      );
    }
  );
});
