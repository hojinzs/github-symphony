import { describe, expect, it, vi } from "vitest";

const listInstances = vi.hoisted(() => vi.fn());
vi.mock("../instances.js", () => ({ listInstances }));

const command = (await import("./instances.js")).default;

describe("instances command", () => {
  it("renders all operator fields in aligned columns", async () => {
    listInstances.mockResolvedValueOnce([
      {
        status: "running",
        projectId: "project-a",
        repo: "acme/repo",
        workspacePath: "/work/a",
        pid: 123,
        uptimeMs: 3_660_000,
        phase: "implementation",
        endpoint: "http://localhost:8080",
      },
      {
        status: "stale-registry",
        projectId: "project-b",
        repo: "acme/other",
        workspacePath: "/work/b",
        pid: 456,
        uptimeMs: 0,
        phase: null,
      },
    ]);
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await command([], {
      configDir: "/ignored",
      verbose: false,
      json: false,
      noColor: true,
    });

    expect(write).toHaveBeenCalledWith(expect.stringContaining("UPTIME"));
    expect(write).toHaveBeenCalledWith(expect.stringContaining("PHASE"));
    expect(write).toHaveBeenCalledWith(expect.stringContaining("1h 1m"));
    expect(write).toHaveBeenCalledWith(
      expect.stringContaining("implementation")
    );
    expect(write).toHaveBeenCalledWith(expect.stringContaining("0s"));
  });

  it("emits the complete listing with --json", async () => {
    const instances = [
      { status: "running", projectId: "project-a", phase: "planning" },
    ];
    listInstances.mockResolvedValueOnce(instances);
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await command([], {
      configDir: "/ignored",
      verbose: false,
      json: true,
      noColor: true,
    });

    expect(write).toHaveBeenCalledWith(
      JSON.stringify(instances, null, 2) + "\n"
    );
  });
});
