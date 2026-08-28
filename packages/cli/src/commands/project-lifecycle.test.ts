import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const startMock = vi.fn();
const statusMock = vi.fn();
const stopMock = vi.fn();

vi.mock("./start.js", () => ({ default: startMock }));
vi.mock("./status.js", () => ({ default: statusMock }));
vi.mock("./stop.js", () => ({ default: stopMock }));

const { default: projectCommand, standaloneProjectId } =
  await import("./project.js");

const workflow = `---
tracker:
  kind: github-project
  project_id: PVT_example
codex:
  command: codex app-server
repository:
  slug: acme/platform
---
Implement the issue.`;

const baseOptions = (configDir: string) => ({
  configDir,
  verbose: false,
  json: false,
  noColor: true,
});

afterEach(() => {
  startMock.mockReset();
  statusMock.mockReset();
  stopMock.mockReset();
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("standalone project lifecycle command", () => {
  it("addresses the project by folder for list, start, status, and stop", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-project-config-"));
    const projectDir = await mkdtemp(join(tmpdir(), "cli-project-dir-"));
    await writeFile(join(projectDir, "WORKFLOW.md"), workflow, "utf8");
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await projectCommand(
      ["start", "--daemon", "--allow-duplicate", "--project-dir", projectDir],
      baseOptions(configDir)
    );
    await projectCommand(["list"], { ...baseOptions(configDir), json: true });
    await projectCommand(
      ["status", "--project-dir", projectDir],
      baseOptions(configDir)
    );
    await projectCommand(
      ["stop", "--project-dir", projectDir],
      baseOptions(configDir)
    );

    const projectId = standaloneProjectId(projectDir);
    expect(
      stdout.mock.calls.map(([chunk]) => String(chunk)).join("")
    ).toContain(projectDir);
    expect(startMock).toHaveBeenCalledWith(
      ["--daemon", "--allow-duplicate"],
      expect.objectContaining({ configDir, invocation: "project", projectId })
    );
    expect(statusMock).toHaveBeenCalledWith(
      [],
      expect.objectContaining({ configDir, projectId })
    );
    expect(stopMock).toHaveBeenCalledWith(
      [],
      expect.objectContaining({ configDir, projectId })
    );
  });

  it("starts the project in the working directory without a flag", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-project-config-"));
    const projectDir = await mkdtemp(join(tmpdir(), "cli-project-dir-"));
    await writeFile(join(projectDir, "WORKFLOW.md"), workflow, "utf8");
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(projectDir);

    await projectCommand(["start"], baseOptions(configDir));

    expect(startMock).toHaveBeenCalledWith(
      [],
      expect.objectContaining({ projectId: standaloneProjectId(projectDir) })
    );
    cwd.mockRestore();
  });

  it("refuses to stop a directory that was never started", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-project-config-"));
    const projectDir = await mkdtemp(join(tmpdir(), "cli-project-dir-"));
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await projectCommand(
      ["stop", "--project-dir", projectDir],
      baseOptions(configDir)
    );

    expect(stopMock).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(
      stderr.mock.calls.map(([chunk]) => String(chunk)).join("")
    ).toContain("No standalone project runtime for");
  });

  it("stops a started project even after its WORKFLOW.md is gone", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-project-config-"));
    const projectDir = await mkdtemp(join(tmpdir(), "cli-project-dir-"));
    const workflowPath = join(projectDir, "WORKFLOW.md");
    await writeFile(workflowPath, workflow, "utf8");
    await projectCommand(
      ["start", "--project-dir", projectDir],
      baseOptions(configDir)
    );
    await rm(workflowPath);

    await projectCommand(
      ["stop", "--project-dir", projectDir],
      baseOptions(configDir)
    );

    expect(stopMock).toHaveBeenCalledWith(
      [],
      expect.objectContaining({ projectId: standaloneProjectId(projectDir) })
    );
  });
});
