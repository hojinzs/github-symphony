import { describe, expect, it } from "vitest";
import { resolveTrackerCredentialPreflight } from "./tracker-credential-preflight.js";

describe("resolveTrackerCredentialPreflight", () => {
  it("rejects a GitHub worker without a credential before launch", () => {
    expect(
      resolveTrackerCredentialPreflight({
        SYMPHONY_TRACKER_ADAPTER: "github-project",
        SYMPHONY_PROJECT_DIR: "/managed/projects/acme",
      })
    ).toEqual({
      ok: false,
      reason:
        "Worker GitHub credential preflight failed: GITHUB_GRAPHQL_TOKEN or both GITHUB_TOKEN_BROKER_URL and GITHUB_TOKEN_BROKER_SECRET are required. Add the credential to /managed/projects/acme/.env, or authenticate the daemon environment and restart it.",
    });
  });

  it("accepts a direct GitHub GraphQL token", () => {
    expect(
      resolveTrackerCredentialPreflight({
        SYMPHONY_TRACKER_ADAPTER: "github-project",
        GITHUB_GRAPHQL_TOKEN: "github-token",
      })
    ).toEqual({ ok: true });
  });

  it("requires a complete GitHub broker configuration", () => {
    expect(
      resolveTrackerCredentialPreflight({
        SYMPHONY_TRACKER_ADAPTER: "github-project",
        GITHUB_TOKEN_BROKER_URL: "https://broker.example/token",
      })
    ).toMatchObject({ ok: false });

    expect(
      resolveTrackerCredentialPreflight({
        SYMPHONY_TRACKER_ADAPTER: "github-project",
        GITHUB_TOKEN_BROKER_URL: "https://broker.example/token",
        GITHUB_TOKEN_BROKER_SECRET: "broker-secret",
      })
    ).toEqual({ ok: true });
  });

  it("accepts either supported Linear credential", () => {
    expect(
      resolveTrackerCredentialPreflight({
        SYMPHONY_TRACKER_ADAPTER: "linear",
        LINEAR_API_KEY: "linear-key",
      })
    ).toEqual({ ok: true });
    expect(
      resolveTrackerCredentialPreflight({
        SYMPHONY_TRACKER_ADAPTER: "linear",
        LINEAR_AUTHORIZATION: "Bearer linear-key",
      })
    ).toEqual({ ok: true });
  });

  it("rejects a Linear worker without a credential", () => {
    expect(
      resolveTrackerCredentialPreflight({
        SYMPHONY_TRACKER_ADAPTER: "linear",
      })
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining(
        "LINEAR_AUTHORIZATION or LINEAR_API_KEY is required"
      ),
    });
  });

  it("does not require hosted credentials for other tracker adapters", () => {
    expect(
      resolveTrackerCredentialPreflight({
        SYMPHONY_TRACKER_ADAPTER: "file",
      })
    ).toEqual({ ok: true });
  });
});
