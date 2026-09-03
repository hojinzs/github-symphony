import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareAgentChildHome,
  resolveAgentChildHome,
  stageDockerCliPlugins,
  stageJsonCredentialFile,
} from "./child-home.js";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

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

  it("stages resolved Docker CLI plugins without host credential config", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-child-docker-"));
    roots.push(root);
    const hostHome = join(root, "host");
    const plugins = join(hostHome, ".docker", "cli-plugins");
    const executable = join(root, "docker-compose");
    const destination = join(root, "child", ".docker", "cli-plugins");
    await mkdir(plugins, { recursive: true });
    await writeFile(
      executable,
      "#!/bin/sh\nprintf 'Compose test plugin\\n'\n",
      {
        mode: 0o755,
      }
    );
    await symlink(executable, join(plugins, "docker-compose"));
    await writeFile(
      join(hostHome, ".docker", "config.json"),
      JSON.stringify({ auths: { "registry.example": { auth: "secret" } } })
    );

    await expect(
      stageDockerCliPlugins({ sourceHome: hostHome, destination })
    ).resolves.toBe(1);
    expect(await readlink(join(destination, "docker-compose"))).toBe(
      await realpath(executable)
    );
    expect((await stat(destination)).mode & 0o777).toBe(0o700);
    await expect(
      execFileAsync(join(destination, "docker-compose"), ["version"], {
        env: {
          HOME: join(root, "child"),
          DOCKER_CONFIG: join(root, "child", ".docker"),
        },
      })
    ).resolves.toMatchObject({ stdout: "Compose test plugin\n" });
    await expect(
      readFile(join(root, "child", ".docker", "config.json"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves the child Docker config absent when the host has no plugins", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-child-no-docker-"));
    roots.push(root);
    const destination = join(root, "child", ".docker", "cli-plugins");

    await expect(
      stageDockerCliPlugins({
        sourceHome: join(root, "host"),
        destination,
      })
    ).resolves.toBe(0);
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
