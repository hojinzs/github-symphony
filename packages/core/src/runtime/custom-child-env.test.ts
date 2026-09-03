import { describe, expect, it } from "vitest";
import { buildCustomRuntimeChildEnvironment } from "./custom-child-env.js";

describe("buildCustomRuntimeChildEnvironment", () => {
  it("forwards only portable values and declared authentication by default", () => {
    const env = buildCustomRuntimeChildEnvironment({
      childHome: "/runtime/child-home",
      source: {
        HOME: "/operator-home",
        USERPROFILE: "C:\\operator-home",
        PATH: "/bin",
        GITHUB_TOKEN: "github-secret",
        LINEAR_API_KEY: "linear-secret",
        GITHUB_TOKEN_BROKER_SECRET: "broker-secret",
        AGENT_CREDENTIAL_BROKER_SECRET: "agent-broker-secret",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "store",
        SYMPHONY_TRACKER_SECRET_ENVIRONMENT_NAMES: JSON.stringify([
          "TRACKER_SECRET",
        ]),
        TRACKER_SECRET: "tracker-secret",
      },
      input: { CUSTOM_AGENT_TOKEN: "custom-token" },
      authEnvKey: "CUSTOM_AGENT_TOKEN",
    });

    expect(env).toMatchObject({
      PATH: "/bin",
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

  it("keeps private home and strips Git credential helpers in compatibility mode", () => {
    const env = buildCustomRuntimeChildEnvironment({
      childHome: "/runtime/child-home",
      source: {
        HOME: "/operator-home",
        USERPROFILE: "C:\\operator-home",
        GH_CONFIG_DIR: "/operator-home/.config/gh",
        GITHUB_TOKEN: "github-secret",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "store",
      },
      inheritEnvironment: true,
    });

    expect(env).toMatchObject({
      GITHUB_TOKEN: "github-secret",
      HOME: "/runtime/child-home",
      USERPROFILE: "/runtime/child-home",
      GH_CONFIG_DIR: "/runtime/child-home/gh",
      GIT_TERMINAL_PROMPT: "0",
    });
    expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(env.GIT_CONFIG_VALUE_0).toBeUndefined();
  });
});
