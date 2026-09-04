import { describe, expect, it } from "vitest";
import type { OrchestratorProjectConfig } from "@gh-symphony/core";
import { githubProjectTrackerAdapter } from "@gh-symphony/tracker-github";
import { linearTrackerAdapter } from "@gh-symphony/tracker-linear";
import { resolveTrackerCredentialPreflight } from "./tracker-credential-preflight.js";

const project = {} as OrchestratorProjectConfig;

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

  it.each([
    ["github-project", githubProjectTrackerAdapter, {}],
    [
      "github-project",
      githubProjectTrackerAdapter,
      { GITHUB_GRAPHQL_TOKEN: "token" },
    ],
    ["github-project", githubProjectTrackerAdapter, { GITHUB_TOKEN: "token" }],
    [
      "github-project",
      githubProjectTrackerAdapter,
      { GITHUB_TOKEN_BROKER_URL: "https://broker.example/token" },
    ],
    [
      "github-project",
      githubProjectTrackerAdapter,
      {
        GITHUB_TOKEN_BROKER_URL: "https://broker.example/token",
        GITHUB_TOKEN_BROKER_SECRET: "secret",
      },
    ],
    ["linear", linearTrackerAdapter, {}],
    ["linear", linearTrackerAdapter, { LINEAR_API_KEY: "key" }],
    ["linear", linearTrackerAdapter, { LINEAR_AUTHORIZATION: "Bearer token" }],
  ] as const)(
    "matches the %s adapter credential contract for %j",
    (adapterName, adapter, environment) => {
      const preflight = resolveTrackerCredentialPreflight({
        SYMPHONY_TRACKER_ADAPTER: adapterName,
        ...environment,
      });
      const credentials = adapter.resolveWorkerCredentials?.(project, {
        project: {},
        daemon: environment,
      });

      expect(preflight.ok).toBe(
        credentials !== undefined && Object.keys(credentials).length > 0
      );
    }
  );
});
