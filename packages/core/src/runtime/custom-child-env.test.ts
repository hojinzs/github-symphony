import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCustomRuntimeChildEnvironment } from "./custom-child-env.js";

describe("buildCustomRuntimeChildEnvironment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("forwards only portable values and declared authentication by default", () => {
    const env = buildCustomRuntimeChildEnvironment({
      childHome: "/runtime/child-home",
      source: {
        HOME: "/operator-home",
        USERPROFILE: "C:\\operator-home",
        PATH: "/bin",
        SYMPHONY_ASSIGNED_BRANCH: "symphony/acme-42",
        SYMPHONY_ISSUE_IDENTIFIER: "acme/repo#42",
        GITHUB_TOKEN: "github-secret",
        LINEAR_API_KEY: "linear-secret",
        GITHUB_TOKEN_BROKER_SECRET: "broker-secret",
        AGENT_CREDENTIAL_BROKER_SECRET: "agent-broker-secret",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "store",
        SYMPHONY_TRACKER_SECRET_ENVIRONMENT_NAMES: JSON.stringify([
          "GITHUB_TOKEN",
          "GITHUB_TOKEN_BROKER_SECRET",
          "LINEAR_API_KEY",
          "TRACKER_SECRET",
        ]),
        TRACKER_SECRET: "tracker-secret",
      },
      input: { CUSTOM_AGENT_TOKEN: "custom-token" },
      authEnvKey: "CUSTOM_AGENT_TOKEN",
    });

    expect(env).toMatchObject({
      PATH: "/bin",
      SYMPHONY_ASSIGNED_BRANCH: "symphony/acme-42",
      SYMPHONY_ISSUE_IDENTIFIER: "acme/repo#42",
      CUSTOM_AGENT_TOKEN: "custom-token",
      HOME: "/runtime/child-home",
      USERPROFILE: "/runtime/child-home",
      GH_CONFIG_DIR: "/runtime/child-home/gh",
      GIT_TERMINAL_PROMPT: "0",
    });
    for (const name of [
      "GITHUB_TOKEN",
      "LINEAR_API_KEY",
      "GITHUB_TOKEN_BROKER_SECRET",
      "AGENT_CREDENTIAL_BROKER_SECRET",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      "TRACKER_SECRET",
    ]) {
      expect(env[name]).toBeUndefined();
    }
  });

  it("keeps private home and strips credentials in compatibility mode", () => {
    const env = buildCustomRuntimeChildEnvironment({
      childHome: "/runtime/child-home",
      source: {
        HOME: "/operator-home",
        USERPROFILE: "C:\\operator-home",
        GH_CONFIG_DIR: "/operator-home/.config/gh",
        GITHUB_TOKEN: "github-secret",
        GITHUB_TOKEN_BROKER_SECRET: "broker-secret",
        SYMPHONY_TRACKER_SECRET_ENVIRONMENT_NAMES: JSON.stringify([
          "GITHUB_TOKEN",
          "GITHUB_TOKEN_BROKER_SECRET",
        ]),
        SYMPHONY_ASSIGNED_BRANCH: "symphony/acme-42",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "store",
      },
      inheritEnvironment: true,
    });

    expect(env).toMatchObject({
      SYMPHONY_ASSIGNED_BRANCH: "symphony/acme-42",
      HOME: "/runtime/child-home",
      USERPROFILE: "/runtime/child-home",
      GH_CONFIG_DIR: "/runtime/child-home/gh",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(env.GIT_CONFIG_VALUE_0).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.GITHUB_TOKEN_BROKER_SECRET).toBeUndefined();
  });

  it("sanitizes process-only repository context in compatibility mode", () => {
    vi.stubEnv(
      "TARGET_REPOSITORY_CLONE_URL",
      "https://operator:secret@example.com/acme/repo.git"
    );

    const env = buildCustomRuntimeChildEnvironment({
      childHome: "/runtime/child-home",
      inheritEnvironment: true,
    });

    expect(env.TARGET_REPOSITORY_CLONE_URL).toBe(
      "https://example.com/acme/repo.git"
    );
  });

  it("strips process-only tracker secrets in compatibility mode", () => {
    vi.stubEnv(
      "SYMPHONY_TRACKER_SECRET_ENVIRONMENT_NAMES",
      '["PROCESS_ONLY_TRACKER_SECRET"]'
    );
    vi.stubEnv("PROCESS_ONLY_TRACKER_SECRET", "tracker-secret");

    const env = buildCustomRuntimeChildEnvironment({
      childHome: "/runtime/child-home",
      inheritEnvironment: true,
    });

    expect(env.PROCESS_ONLY_TRACKER_SECRET).toBeUndefined();
  });

  it("removes URL userinfo from agent-visible repository context", () => {
    const env = buildCustomRuntimeChildEnvironment({
      childHome: "/runtime/child-home",
      source: {
        TARGET_REPOSITORY_CLONE_URL:
          "https://operator:secret@example.com/acme/repo.git?mirror=1#ref",
      },
    });

    expect(env.TARGET_REPOSITORY_CLONE_URL).toBe(
      "https://example.com/acme/repo.git?mirror=1#ref"
    );
  });

  it("rejects runtime auth that becomes reserved at child composition", () => {
    expect(() =>
      buildCustomRuntimeChildEnvironment({
        childHome: "/runtime/child-home",
        source: {
          SYMPHONY_TRACKER_SECRET_ENVIRONMENT_NAMES: '["CUSTOM_AGENT_TOKEN"]',
        },
        input: { CUSTOM_AGENT_TOKEN: "custom-token" },
        authEnvKey: "CUSTOM_AGENT_TOKEN",
      })
    ).toThrow(
      "Custom runtime auth environment variable CUSTOM_AGENT_TOKEN is reserved"
    );
  });
});
