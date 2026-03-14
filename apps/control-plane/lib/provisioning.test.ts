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
  teardownWorkspaceRuntime,
} from "./provisioning";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0, tempPaths.length).map((path) =>
      rm(path, {
        recursive: true,
        force: true,
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
            cloneUrl: "https://github.com/acme/platform.git",
          },
        ],
      })
    ).toContain("Prefer small changes");
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
            cloneUrl: "https://github.com/acme/platform.git",
          },
        ],
      })
    ).toContain("lifecycle:");
  });
});

describe("provisionWorkspaceRuntime", () => {
  it("writes runtime artifacts and persists orchestrator-owned runtime metadata", async () => {
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
            Status: "running",
          },
        }),
      }),
      getContainer: vi.fn(),
    };

    const db = {
      symphonyInstance: {
        upsert: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
      },
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
            cloneUrl: "https://github.com/acme/platform.git",
          },
        ],
      },
      {
        db,
        docker,
        runtimeRoot: root,
        portAllocator: async () => 4501,
        runtimeAuthEnv: {
          WORKSPACE_RUNTIME_AUTH_SECRET: "runtime-auth-secret",
        },
      }
    );

    expect(runtime.runtimeDriver).toBe("docker");
    expect(runtime.runtimeId).toBe("workspace-workspace-1");
    expect(runtime.runtimeName).toBe("orchestrator-platform");
    expect(runtime.port).toBe(0);
    expect(runtime.workflowPath).toBe(
      join(runtime.workspaceRuntimeDir, "WORKFLOW.md")
    );
    expect(
      readFileSync(join(runtime.workspaceRuntimeDir, "worker.env"), "utf8")
    ).toContain("GITHUB_PROJECT_ID=project-1");
    expect(
      readFileSync(join(runtime.workspaceRuntimeDir, "worker.env"), "utf8")
    ).toContain("GITHUB_TOKEN_BROKER_URL=");
    expect(
      readFileSync(join(runtime.workspaceRuntimeDir, "worker.env"), "utf8")
    ).toContain("AGENT_CREDENTIAL_BROKER_URL=");
    expect(
      readFileSync(join(runtime.workspaceRuntimeDir, "worker.env"), "utf8")
    ).toContain("SYMPHONY_RUNTIME_DRIVER=docker");
    expect(
      readFileSync(
        join(runtime.workspaceRuntimeDir, "hooks", "after_create.sh"),
        "utf8"
      )
    ).toContain('git -C "$repository_dir" pull --ff-only');
    expect(docker.createContainer).not.toHaveBeenCalled();
    expect(db.symphonyInstance.upsert).toHaveBeenCalledTimes(1);
  });

  it("persists local runtime metadata without launching a worker eagerly", async () => {
    const root = mkdtempSync(join(tmpdir(), "github-symphony-local-runtime-"));
    tempPaths.push(root);

    const spawnImpl = vi.fn().mockReturnValue({
      pid: 4321,
      unref: vi.fn(),
    });
    const db = {
      symphonyInstance: {
        upsert: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue(undefined),
      },
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
            cloneUrl: "https://github.com/acme/platform.git",
          },
        ],
      },
      {
        db,
        runtimeDriver: "local",
        runtimeRoot: root,
        portAllocator: async () => 4502,
        runtimeAuthEnv: {
          WORKSPACE_RUNTIME_AUTH_SECRET: "runtime-auth-secret",
        },
        workerCommand: "node packages/worker/dist/index.js",
        projectRoot: "/tmp/github-symphony",
        spawnImpl,
      }
    );

    expect(runtime.runtimeDriver).toBe("local");
    expect(runtime.runtimeId).toBe("workspace-workspace-2");
    expect(runtime.processId).toBeNull();
    expect(
      readFileSync(join(runtime.workspaceRuntimeDir, "worker.env"), "utf8")
    ).toContain("SYMPHONY_RUNTIME_DRIVER=local");
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(db.symphonyInstance.upsert).toHaveBeenCalledTimes(1);
  });

  it("syncs runtime state from orchestrator status API", async () => {
    const container = {
      inspect: vi.fn().mockResolvedValue({
        State: {
          Running: true,
          Status: "running",
        },
      }),
      start: vi.fn(),
      stop: vi.fn(),
      remove: vi.fn(),
    };

    const docker = {
      createContainer: vi.fn(),
      getContainer: vi.fn().mockReturnValue(container),
    };

    const db = {
      symphonyInstance: {
        upsert: vi.fn(),
        update: vi.fn().mockResolvedValue(undefined),
      },
    };

    const status = await syncWorkspaceRuntimeStatus(
      {
        workspaceId: "workspace-1",
        runtimeDriver: "docker",
        runtimeId: "container-1",
      },
      {
        db,
        docker,
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              workspaceId: "workspace-1",
              slug: "workspace-1",
              tracker: {
                adapter: "github-project",
                bindingId: "project-1",
              },
              lastTickAt: "2026-03-09T00:00:00.000Z",
              health: "running",
              summary: {
                dispatched: 1,
                suppressed: 0,
                recovered: 0,
                activeRuns: 1,
              },
              activeRuns: [
                {
                  runId: "run-1",
                  issueIdentifier: "acme/platform#1",
                  phase: "planning",
                  status: "running",
                  retryKind: null,
                  port: 4501,
                },
              ],
              retryQueue: [],
              lastError: null,
            }),
            { status: 200 }
          )
        ) as typeof fetch,
      }
    );

    expect(status).toBe("running");
    expect(db.symphonyInstance.update).toHaveBeenCalledTimes(1);
  });

  it("tears down a runtime by persisting the stopped state", async () => {
    const container = {
      inspect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };

    const docker = {
      createContainer: vi.fn(),
      getContainer: vi.fn().mockReturnValue(container),
    };

    const db = {
      symphonyInstance: {
        upsert: vi.fn(),
        update: vi.fn().mockResolvedValue(undefined),
      },
    };

    await teardownWorkspaceRuntime(
      {
        workspaceId: "workspace-1",
        runtimeDriver: "docker",
        runtimeId: "container-1",
      },
      {
        db,
        docker,
      }
    );

    expect(container.stop).not.toHaveBeenCalled();
    expect(container.remove).not.toHaveBeenCalled();
    expect(db.symphonyInstance.update).toHaveBeenCalledTimes(1);
  });

  it("reconciles failed provisioning by persisting a degraded state", async () => {
    const container = {
      inspect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      remove: vi.fn().mockResolvedValue(undefined),
    };

    const docker = {
      createContainer: vi.fn(),
      getContainer: vi.fn().mockReturnValue(container),
    };

    const db = {
      symphonyInstance: {
        upsert: vi.fn(),
        update: vi.fn().mockResolvedValue(undefined),
      },
    };

    await reconcileProvisioningFailure(
      {
        workspaceId: "workspace-1",
        runtimeDriver: "docker",
        runtimeId: "container-1",
      },
      {
        db,
        docker,
      }
    );

    expect(container.remove).not.toHaveBeenCalled();
    expect(db.symphonyInstance.update).toHaveBeenCalledTimes(1);
  });

  it("reconciles local runtime state from orchestrator status", async () => {
    const db = {
      symphonyInstance: {
        upsert: vi.fn(),
        update: vi.fn().mockResolvedValue(undefined),
      },
    };

    const status = await syncWorkspaceRuntimeStatus(
      {
        workspaceId: "workspace-2",
        runtimeDriver: "local",
        runtimeId: "local-workspace-2",
        processId: 4321,
      },
      {
        db,
        fetchImpl: vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              workspaceId: "workspace-2",
              slug: "workspace-2",
              tracker: {
                adapter: "github-project",
                bindingId: "project-2",
              },
              lastTickAt: "2026-03-09T00:00:00.000Z",
              health: "running",
              summary: {
                dispatched: 0,
                suppressed: 0,
                recovered: 0,
                activeRuns: 1,
              },
              activeRuns: [
                {
                  runId: "run-2",
                  issueIdentifier: "acme/platform#2",
                  phase: "planning",
                  status: "running",
                  retryKind: null,
                  port: 4502,
                },
              ],
              retryQueue: [],
              lastError: null,
            }),
            { status: 200 }
          )
        ) as typeof fetch,
      }
    );

    expect(status).toBe("running");
  });
});
