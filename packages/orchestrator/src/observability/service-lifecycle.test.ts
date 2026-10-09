import { mkdtemp, writeFile, rm, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { OrchestratorProjectConfig } from "@gh-symphony/core";
import { OrchestratorFsStore } from "../fs-store.js";
import { OrchestratorService } from "../service.js";
import type { TelemetryStatus } from "./lifecycle.js";

const loadPipeline = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("SDK graph evaluated");
  })
);
vi.mock("./pipeline.js", () => {
  loadPipeline();
  return {};
});
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "otlp-h-service-"));
  roots.push(root);
  const issues = join(root, "issues.json");
  await writeFile(issues, "[]");
  const workflow = join(root, "WORKFLOW.md");
  const project: OrchestratorProjectConfig = {
    projectId: "p",
    slug: "o/r",
    projectDir: root,
    workspaceDir: join(root, "work"),
    repository: { owner: "o", name: "r", cloneUrl: join(root, "repo") },
    tracker: {
      adapter: "file",
      bindingId: "file",
      settings: { issuesPath: issues },
    },
    workflowSource: { type: "external", path: workflow },
  };
  const update = async (
    enabled: boolean,
    endpoint = "https://collector.example",
    resourceYaml = ""
  ) =>
    writeFile(
      workflow,
      `---\ntracker:\n  kind: file\n  provider:\n    path: ${issues}\nworkspace:\n  root: ${project.workspaceDir}\nobservability:\n  otlp:\n    enabled: ${enabled}\n    endpoint: ${endpoint}${enabled ? "\n    headers:\n      Authorization: $H_COLLECTOR_AUTH" : ""}${resourceYaml}\n---\nWork on {{issue.identifier}}.\n`
    );
  vi.stubEnv("H_COLLECTOR_AUTH", "Bearer secret-h");
  const store = new OrchestratorFsStore(join(root, "runtime"));
  await store.saveProjectConfig(project);
  return { root, store, project, update };
}

it("OT-03: service rejects production enable before dispatch and disabled startup loads no pipeline", async () => {
  const f = await fixture();
  await f.update(true);
  const service = new OrchestratorService(f.store, f.project);
  await expect(service.run({ once: true })).rejects.toThrow("unsupported");
  await service.shutdown();
  await f.update(false);
  const createPipeline = vi.fn();
  const disabled = new OrchestratorService(f.store, f.project, {
    telemetry: { createPipeline },
  });
  const status = await disabled.runOnce();
  expect(
    (status as typeof status & { telemetry: TelemetryStatus }).telemetry.state
  ).toBe("disabled");
  expect(createPipeline).not.toHaveBeenCalled();
  expect(loadPipeline).not.toHaveBeenCalled();
  await disabled.shutdown();
});

it("OT-10/12: committed service status preserves applied, invalid reload, revert and child stripping", async () => {
  const f = await fixture();
  await f.update(true);
  const offerEvent = vi.fn();
  const offerSnapshot = vi.fn();
  const observeTick = vi.fn();
  const shutdown = vi.fn(async () => {});
  const stderr = { write: vi.fn() };
  const createPipeline = vi.fn(async () => ({
    offerEvent,
    offerSnapshot,
    observeTick,
    shutdown,
    diagnostics: () => {
      throw new Error("secret-diagnostic-echo");
    },
  }));
  const service = new OrchestratorService(f.store, f.project, {
    telemetry: { createPipeline },
    stderr,
  });
  const first = await service.runOnce();
  expect(first.lastError).toBeNull();
  expect(
    (first as typeof first & { telemetry: TelemetryStatus }).telemetry.state
  ).toBe("degraded");
  expect(JSON.stringify(first)).not.toContain("secret-diagnostic-echo");
  expect(offerSnapshot).toHaveBeenCalledTimes(1);
  expect(observeTick).toHaveBeenCalledTimes(1);
  await mkdir(f.store.runDir("r", "p"), { recursive: true });
  await f.store.appendRunEvent("r", {
    at: new Date().toISOString(),
    event: "run-failed",
    runId: "r",
    projectId: "p",
    error: "safe",
  });
  expect(offerEvent).toHaveBeenCalledTimes(1);
  await f.update(false);
  await service.runOnce();
  const status = (await service.status()) as typeof first & {
    telemetry: TelemetryStatus;
  };
  expect(status.telemetry).toMatchObject({
    enabled: true,
    pending: { enabled: false },
    restartRequired: true,
  });
  expect(stderr.write).toHaveBeenCalledWith(
    expect.stringContaining("remains active")
  );
  const child = (
    service as unknown as {
      buildProjectExecutionEnv: (
        p: OrchestratorProjectConfig,
        e: Record<string, string>
      ) => Record<string, string>;
    }
  ).buildProjectExecutionEnv(f.project, {
    H_COLLECTOR_AUTH: "Bearer secret-h",
  });
  expect(child).not.toHaveProperty("H_COLLECTOR_AUTH");
  await f.update(
    false,
    "https://collector.example",
    "\nruntime:\n  kind: custom\n  command: echo test\n  auth:\n    env: H_COLLECTOR_AUTH"
  );
  const sharedName = (await service.runOnce()) as typeof first & {
    telemetry: TelemetryStatus;
  };
  expect(sharedName.workflow).toMatchObject({
    isValid: false,
    usedLastKnownGood: true,
  });
  expect(sharedName.lastError).toContain(
    "conflicts with agent/tracker authentication"
  );
  expect(sharedName.telemetry).toEqual(status.telemetry);
  await f.update(true, "https://user:secret-invalid@collector.example");
  const invalid = (await service.runOnce()) as typeof first & {
    telemetry: TelemetryStatus;
  };
  expect(invalid.workflow).toMatchObject({
    isValid: false,
    usedLastKnownGood: true,
  });
  expect(invalid.telemetry).toEqual(status.telemetry);
  await f.update(
    true,
    "https://collector.example",
    "\n    resource_attributes:\n      service.name: invalid-service"
  );
  const invalidResource = (await service.runOnce()) as typeof first & {
    telemetry: TelemetryStatus;
  };
  expect(invalidResource.workflow).toMatchObject({
    isValid: false,
    usedLastKnownGood: true,
  });
  expect(invalidResource.telemetry).toEqual(status.telemetry);
  await f.update(true);
  await service.runOnce();
  expect(((await service.status()) as typeof status).telemetry).toMatchObject({
    pending: null,
    restartRequired: false,
  });
  expect(createPipeline).toHaveBeenCalledTimes(1);
  const persisted = await readFile(
    join(f.store.projectDir("p"), "status.json"),
    "utf8"
  );
  expect(persisted).not.toContain("secret-h");
  expect(persisted).not.toContain("secret-invalid");
  await service.shutdown();
  expect(shutdown).toHaveBeenCalledTimes(1);
});
