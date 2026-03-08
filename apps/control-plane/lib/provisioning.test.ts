import { mkdtempSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  reconcileProvisioningFailure,
  provisionWorkspaceRuntime,
  renderWorkflowMarkdown,
  syncWorkspaceRuntimeStatus,
  teardownWorkspaceRuntime
} from "./provisioning";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0, tempPaths.length).map((path) =>
      rm(path, {
        recursive: true,
        force: true
      })
    )
  );
});

describe("renderWorkflowMarkdown", () => {
  it("renders workflow instructions for a workspace", () => {
    expect(
      renderWorkflowMarkdown({
        workspaceId: "workspace-1",
        slug: "platform",
        promptGuidelines: "Prefer small changes",
        githubProjectId: "project-1",
        agentCredentialSource: "platform_default",
        repositories: [
          {
            owner: "acme",
            name: "platform",
            cloneUrl: "https://github.com/acme/platform.git"
          }
        ]
      })
    ).toContain("Project ID: project-1");
    expect(
      renderWorkflowMarkdown({
        workspaceId: "workspace-1",
        slug: "platform",
        promptGuidelines: "Prefer small changes",
        githubProjectId: "project-1",
        agentCredentialSource: "platform_default",
        repositories: [
          {
            owner: "acme",
            name: "platform",
            cloneUrl: "https://github.com/acme/platform.git"
          }
        ]
      })
    ).toContain("## Approval Lifecycle");
  });
});

describe("provisionWorkspaceRuntime", () => {
  it("writes runtime artifacts, starts a container, and persists instance metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "github-symphony-provision-"));
    tempPaths.push(root);

    const docker = {
      createContainer: vi.fn().mockResolvedValue({
        id: "container-1",
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(undefined),
        inspect: vi.fn().mockResolvedValue({
          State: {
            Running: true,
            Status: "running"
          }
        })
      }),
      getContainer: vi.fn()
    };

    const db = {
      symphonyInstance: {
        upsert: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined)
      }
    };

    const runtime = await provisionWorkspaceRuntime(
      {
        workspaceId: "workspace-1",
        slug: "platform",
        promptGuidelines: "Prefer small changes",
        githubProjectId: "project-1",
        agentCredentialSource: "platform_default",
        repositories: [
          {
            owner: "acme",
            name: "platform",
            cloneUrl: "https://github.com/acme/platform.git"
          }
        ]
      },
      {
        db,
        docker,
        runtimeRoot: root,
        portAllocator: async () => 4501,
        runtimeAuthEnv: {
          WORKSPACE_RUNTIME_AUTH_SECRET: "runtime-auth-secret"
        }
      }
    );

    expect(runtime.runtimeDriver).toBe("docker");
    expect(runtime.runtimeId).toBe("container-1");
    expect(runtime.runtimeName).toBe("symphony-platform");
    expect(runtime.port).toBe(4501);
    expect(readFileSync(runtime.workflowPath, "utf8")).toContain("Prefer small changes");
    expect(readFileSync(join(runtime.workspaceRuntimeDir, "worker.env"), "utf8")).toContain(
      "GITHUB_PROJECT_ID=project-1"
    );
    expect(readFileSync(join(runtime.workspaceRuntimeDir, "worker.env"), "utf8")).toContain(
      "GITHUB_TOKEN_BROKER_URL="
    );
    expect(readFileSync(join(runtime.workspaceRuntimeDir, "worker.env"), "utf8")).toContain(
      "AGENT_CREDENTIAL_BROKER_URL="
    );
    expect(readFileSync(join(runtime.workspaceRuntimeDir, "worker.env"), "utf8")).toContain(
      "SYMPHONY_RUNTIME_DRIVER=docker"
    );
    expect(docker.createContainer).toHaveBeenCalledTimes(1);
    expect(db.symphonyInstance.upsert).toHaveBeenCalledTimes(1);
  });

  it("starts a local worker process and persists runtime metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "github-symphony-local-runtime-"));
    tempPaths.push(root);

    const spawnImpl = vi.fn().mockReturnValue({
      pid: 4321,
      unref: vi.fn()
    });
    const db = {
      symphonyInstance: {
        upsert: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined)
      }
    };

    const runtime = await provisionWorkspaceRuntime(
      {
        workspaceId: "workspace-2",
        slug: "local-workspace",
        promptGuidelines: "Prefer local runs",
        githubProjectId: "project-2",
        agentCredentialSource: "platform_default",
        repositories: [
          {
            owner: "acme",
            name: "platform",
            cloneUrl: "https://github.com/acme/platform.git"
          }
        ]
      },
      {
        db,
        runtimeDriver: "local",
        runtimeRoot: root,
        portAllocator: async () => 4502,
        runtimeAuthEnv: {
          WORKSPACE_RUNTIME_AUTH_SECRET: "runtime-auth-secret"
        },
        workerCommand: "node packages/worker/dist/index.js",
        projectRoot: "/tmp/github-symphony",
        spawnImpl
      }
    );

    expect(runtime.runtimeDriver).toBe("local");
    expect(runtime.runtimeId).toBe("local-workspace-2");
    expect(runtime.processId).toBe(4321);
    expect(readFileSync(join(runtime.workspaceRuntimeDir, "worker.env"), "utf8")).toContain(
      "SYMPHONY_RUNTIME_DRIVER=local"
    );
    expect(spawnImpl).toHaveBeenCalledWith(
      "bash",
      ["-lc", "node packages/worker/dist/index.js"],
      expect.objectContaining({
        cwd: "/tmp/github-symphony",
        detached: true,
        stdio: "ignore"
      })
    );
    expect(db.symphonyInstance.upsert).toHaveBeenCalledTimes(1);
  });

  it("syncs runtime state from Docker inspection", async () => {
    const container = {
      inspect: vi.fn().mockResolvedValue({
        State: {
          Running: true,
          Status: "running"
        }
      }),
      start: vi.fn(),
      stop: vi.fn(),
      remove: vi.fn()
    };

    const docker = {
      createContainer: vi.fn(),
      getContainer: vi.fn().mockReturnValue(container)
    };

    const db = {
      symphonyInstance: {
        upsert: vi.fn(),
        update: vi.fn().mockResolvedValue(undefined)
      }
    };

    const status = await syncWorkspaceRuntimeStatus(
      {
        workspaceId: "workspace-1",
        runtimeDriver: "docker",
        runtimeId: "container-1"
      },
      {
        db,
        docker
      }
    );

    expect(status).toBe("running");
    expect(db.symphonyInstance.update).toHaveBeenCalledTimes(1);
  });

  it("tears down a runtime and persists the stopped state", async () => {
    const container = {
      inspect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined)
    };

    const docker = {
      createContainer: vi.fn(),
      getContainer: vi.fn().mockReturnValue(container)
    };

    const db = {
      symphonyInstance: {
        upsert: vi.fn(),
        update: vi.fn().mockResolvedValue(undefined)
      }
    };

    await teardownWorkspaceRuntime(
      {
        workspaceId: "workspace-1",
        runtimeDriver: "docker",
        runtimeId: "container-1"
      },
      {
        db,
        docker
      }
    );

    expect(container.stop).toHaveBeenCalledTimes(1);
    expect(container.remove).toHaveBeenCalledWith({
      force: true
    });
    expect(db.symphonyInstance.update).toHaveBeenCalledTimes(1);
  });

  it("reconciles failed provisioning by forcing container cleanup", async () => {
    const container = {
      inspect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      remove: vi.fn().mockResolvedValue(undefined)
    };

    const docker = {
      createContainer: vi.fn(),
      getContainer: vi.fn().mockReturnValue(container)
    };

    const db = {
      symphonyInstance: {
        upsert: vi.fn(),
        update: vi.fn().mockResolvedValue(undefined)
      }
    };

    await reconcileProvisioningFailure(
      {
        workspaceId: "workspace-1",
        runtimeDriver: "docker",
        runtimeId: "container-1"
      },
      {
        db,
        docker
      }
    );

    expect(container.remove).toHaveBeenCalledWith({
      force: true
    });
    expect(db.symphonyInstance.update).toHaveBeenCalledTimes(1);
  });

  it("reconciles local runtime state from process liveness", async () => {
    const killSpy = vi.spyOn(process, "kill").mockReturnValue(true as never);
    const db = {
      symphonyInstance: {
        upsert: vi.fn(),
        update: vi.fn().mockResolvedValue(undefined)
      }
    };

    const status = await syncWorkspaceRuntimeStatus(
      {
        workspaceId: "workspace-2",
        runtimeDriver: "local",
        runtimeId: "local-workspace-2",
        processId: 4321
      },
      {
        db
      }
    );

    expect(status).toBe("running");
    expect(killSpy).toHaveBeenCalledWith(4321, 0);
    killSpy.mockRestore();
  });
});
