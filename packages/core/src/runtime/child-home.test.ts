import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareAgentChildHome,
  resolveAgentChildHome,
  stageJsonCredentialFile,
} from "./child-home.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("resolveAgentChildHome", () => {
  it("keeps the default child home inside the workspace", () => {
    expect(resolveAgentChildHome({ workingDirectory: "/workspace" })).toBe(
      "/workspace/.runtime/child-home"
    );
  });

  it("uses the orchestrator runtime directory when provided", () => {
    expect(
      resolveAgentChildHome({
        workingDirectory: "/workspace",
        runtimeDirectory: "/runtime/run-123",
      })
    ).toBe("/runtime/run-123/child-home");
  });
});

describe("agent child home preparation", () => {
  it("creates private child and gh directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-child-home-"));
    roots.push(root);
    const childHome = join(root, "child-home");

    await prepareAgentChildHome(childHome);

    expect((await stat(childHome)).mode & 0o777).toBe(0o700);
    expect((await stat(join(childHome, "gh"))).mode & 0o777).toBe(0o700);
  });

  it("stages only selected provider credential fields with private permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-child-credential-"));
    roots.push(root);
    const source = join(root, "host-credentials.json");
    const destination = join(root, "child", ".credentials.json");
    await writeFile(
      source,
      JSON.stringify({
        claudeAiOauth: { accessToken: "provider-token" },
        mcpOAuth: { github: "tracker-adjacent-token" },
      })
    );
    await chmod(source, 0o600);

    await stageJsonCredentialFile({
      source,
      destination,
      allowedKeys: ["claudeAiOauth"],
    });

    expect(JSON.parse(await readFile(destination, "utf8"))).toEqual({
      claudeAiOauth: { accessToken: "provider-token" },
    });
    expect((await stat(destination)).mode & 0o777).toBe(0o600);
  });
});
