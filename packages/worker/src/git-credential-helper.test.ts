import { describe, expect, it, vi } from "vitest";
import {
  formatGitCredentialResponse,
  parseGitCredentialRequest,
  resolveGitCredential
} from "./git-credential-helper.js";

describe("parseGitCredentialRequest", () => {
  it("parses git credential key-value input", () => {
    expect(
      parseGitCredentialRequest("protocol=https\nhost=github.com\npath=acme/platform.git\n")
    ).toEqual({
      protocol: "https",
      host: "github.com",
      path: "acme/platform.git"
    });
  });
});

describe("formatGitCredentialResponse", () => {
  it("renders git credential output with the trailing separator line", () => {
    expect(
      formatGitCredentialResponse({
        username: "x-access-token",
        password: "ghs_token"
      })
    ).toBe("username=x-access-token\npassword=ghs_token\n\n");
  });
});

describe("resolveGitCredential", () => {
  it("returns a brokered credential for github.com over https", async () => {
    const response = await resolveGitCredential(
      {
        protocol: "https",
        host: "github.com"
      },
      {
        tokenBrokerUrl: "http://127.0.0.1/runtime-token",
        tokenBrokerSecret: "runtime-secret",
        tokenCachePath: "/tmp/github-token-cache.json"
      },
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            token: "ghs_brokered",
            expiresAt: "2026-03-07T10:20:00.000Z"
          }),
          { status: 200 }
        )
      ) as never
    );

    expect(response).toContain("username=x-access-token");
    expect(response).toContain("password=ghs_brokered");
  });

  it("ignores unsupported hosts or protocols", async () => {
    await expect(
      resolveGitCredential(
        {
          protocol: "ssh",
          host: "github.com"
        },
        {
          token: "ghs_static"
        }
      )
    ).resolves.toBe("");

    await expect(
      resolveGitCredential(
        {
          protocol: "https",
          host: "example.com"
        },
        {
          token: "ghs_static"
        }
      )
    ).resolves.toBe("");
  });
});
