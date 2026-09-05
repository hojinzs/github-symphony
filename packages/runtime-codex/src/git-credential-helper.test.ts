import { describe, expect, it } from "vitest";
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
  it("returns the direct host credential for the configured HTTPS host", async () => {
    const response = await resolveGitCredential(
      { protocol: "https", host: "github.enterprise.example" },
      {
        token: "ghs_direct",
        gitHost: "github.enterprise.example",
        gitUsername: "symphony-service",
      }
    );

    expect(response).toContain("username=symphony-service");
    expect(response).toContain("password=ghs_direct");
  });

  it("rejects a matching host when the direct token is absent", async () => {
    await expect(
      resolveGitCredential({ protocol: "https", host: "github.com" }, {})
    ).rejects.toThrow(
      "GITHUB_GRAPHQL_TOKEN is required for host Git publication."
    );
  });

  it("ignores unsupported hosts or protocols before reading the token", async () => {
    await expect(
      resolveGitCredential(
        { protocol: "ssh", host: "github.com" },
        { token: "ghs_static" }
      )
    ).resolves.toBe("");

    await expect(
      resolveGitCredential(
        { protocol: "https", host: "example.com" },
        { token: "ghs_static" }
      )
    ).resolves.toBe("");
  });
});

describe("resolveGitCredentialHelperConfig", () => {
  it("reads only direct Git publication identity", () => {
    expect(
      resolveGitCredentialHelperConfig({
        GITHUB_GRAPHQL_TOKEN: "direct-token",
        GITHUB_GIT_HOST: "github.enterprise.example",
        GITHUB_GIT_USERNAME: "symphony-service",
        GITHUB_TOKEN_BROKER_URL: "https://broker.example/runtime-token",
        GITHUB_TOKEN_BROKER_SECRET: "unused-secret",
        GITHUB_TOKEN_BROKER_TIMEOUT_MS: "7500",
      })
    ).toEqual({
      token: "direct-token",
      gitHost: "github.enterprise.example",
      gitUsername: "symphony-service",
    });
  });
});
