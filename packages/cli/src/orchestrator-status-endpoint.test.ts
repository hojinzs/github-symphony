import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { resolveProjectOrchestratorStatusBaseUrl } from "./orchestrator-status-endpoint.js";

describe("resolveProjectOrchestratorStatusBaseUrl", () => {
  it("uses the persisted project port when present", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "status-endpoint-"));
    const projectDir = join(configDir, "projects", "tenant-a");
    await mkdir(projectDir, { recursive: true });
    await writeFile(join(projectDir, "port"), "4812\n", "utf8");

    await expect(
      resolveProjectOrchestratorStatusBaseUrl({
        configDir,
        projectId: "tenant-a",
      })
    ).resolves.toBe("http://127.0.0.1:4812");
  });

  it("prefers explicit base URL from the environment", async () => {
    await expect(
      resolveProjectOrchestratorStatusBaseUrl({
        configDir: "/unused",
        projectId: "tenant-a",
        env: {
          ORCHESTRATOR_STATUS_BASE_URL: "http://127.0.0.1:9999",
        } as NodeJS.ProcessEnv,
      })
    ).resolves.toBe("http://127.0.0.1:9999");
  });

  it("returns null when no project port is available", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "status-endpoint-"));

    await expect(
      resolveProjectOrchestratorStatusBaseUrl({
        configDir,
        projectId: "tenant-a",
      })
    ).resolves.toBeNull();
  });
});
