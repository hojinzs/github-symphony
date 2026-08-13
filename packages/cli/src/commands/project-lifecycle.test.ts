import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const startMock = vi.fn();
const statusMock = vi.fn();
const stopMock = vi.fn();

vi.mock("./start.js", () => ({ default: startMock }));
vi.mock("./status.js", () => ({ default: statusMock }));
vi.mock("./stop.js", () => ({ default: stopMock }));

const { default: projectCommand } = await import("./project.js");

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
  it("round-trips add, list, start, status, and stop through one registry", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "cli-project-config-"));
    const projectDir = await mkdtemp(join(tmpdir(), "cli-project-dir-"));
    await writeFile(join(projectDir, "WORKFLOW.md"), workflow, "utf8");
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await projectCommand(["add", projectDir], baseOptions(configDir));
    await projectCommand(["list"], {
      ...baseOptions(configDir),
      json: true,
    });
    await projectCommand(["start", "--daemon"], baseOptions(configDir));
    await projectCommand(["status"], baseOptions(configDir));
    await projectCommand(["stop"], baseOptions(configDir));

    expect(
      stdout.mock.calls.map(([chunk]) => String(chunk)).join("")
    ).toContain(projectDir);
    expect(startMock).toHaveBeenCalledWith(
      ["--daemon"],
      expect.objectContaining({ configDir, invocation: "project" })
    );
    expect(statusMock).toHaveBeenCalledWith(
      [],
      expect.objectContaining({ configDir })
    );
    expect(stopMock).toHaveBeenCalledWith(
      [],
      expect.objectContaining({ configDir })
    );
  });
});
