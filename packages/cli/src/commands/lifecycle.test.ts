import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliTenantConfig } from "../config.js";

const orchestratorRunCli = vi.fn();
const spawnMock = vi.fn();

vi.mock("@gh-symphony/orchestrator", () => ({
  runCli: orchestratorRunCli,
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process"
  );
  return {
    ...actual,
    spawn: spawnMock,
  };
});

const runModule = await import("./run.js");
const startModule = await import("./start.js");
const recoverModule = await import("./recover.js");

afterEach(() => {
  orchestratorRunCli.mockReset();
  spawnMock.mockReset();
  vi.restoreAllMocks();
});

describe("lifecycle command integration", () => {
  it("syncs the selected tenant config before single-issue dispatch", async () => {
    const configDir = await createConfigFixture({
      activeTenant: "tenant-a",
      tenants: [
        createTenant("tenant-a", "acme", "platform"),
        createTenant("tenant-b", "beta", "api"),
      ],
    });

    await runModule.default(
      ["--tenant", "tenant-b", "beta/api#42"],
      baseOptions(configDir)
    );

    expect(orchestratorRunCli).toHaveBeenCalledWith([
      "run-issue",
      "--runtime-root",
      configDir,
      "--tenant-id",
      "tenant-b",
      "--issue",
      "beta/api#42",
    ]);

    const synced = JSON.parse(
      await readFile(
        join(
          configDir,
          "orchestrator",
          "tenants",
          "tenant-b",
          "config.json"
        ),
        "utf8"
      )
    ) as CliTenantConfig;
    expect(synced.tenantId).toBe("tenant-b");
    expect(synced.repositories[0]).toMatchObject({
      owner: "beta",
      name: "api",
    });
  });

  it("starts the requested tenant in daemon mode", async () => {
    const configDir = await createConfigFixture({
      activeTenant: "tenant-a",
      tenants: [
        createTenant("tenant-a", "acme", "platform"),
        createTenant("tenant-b", "beta", "api"),
      ],
    });

    spawnMock.mockReturnValue({
      pid: 4321,
      stdout: { pipe: vi.fn() },
      stderr: { pipe: vi.fn() },
      unref: vi.fn(),
    });

    await startModule.default(
      ["--tenant", "tenant-b", "--daemon"],
      baseOptions(configDir)
    );

    expect(spawnMock).toHaveBeenCalledWith(
      process.execPath,
      [process.argv[1], "start", "--tenant", "tenant-b"],
      expect.objectContaining({
        env: expect.objectContaining({
          GH_SYMPHONY_CONFIG_DIR: configDir,
        }),
      })
    );
  });

  it("reports recoverable runs without invoking recovery in dry-run mode", async () => {
    const configDir = await createConfigFixture({
      activeTenant: "tenant-a",
      tenants: [createTenant("tenant-a", "acme", "platform")],
    });
    const runDir = join(configDir, "orchestrator", "runs", "run-1");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "run.json"),
      JSON.stringify(
        {
          runId: "run-1",
          tenantId: "tenant-a",
          issueIdentifier: "acme/platform#7",
          status: "running",
          processId: 999_999,
          startedAt: new Date().toISOString(),
          nextRetryAt: null,
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await recoverModule.default(["--dry-run"], baseOptions(configDir));

    expect(orchestratorRunCli).not.toHaveBeenCalled();
    expect(
      stdout.mock.calls.some((call) =>
        String(call[0]).includes("acme/platform#7")
      )
    ).toBe(true);
  });
});

function baseOptions(configDir: string) {
  return {
    configDir,
    verbose: false,
    json: false,
    noColor: false,
  };
}

function createTenant(
  tenantId: string,
  owner: string,
  name: string
): CliTenantConfig {
  return {
    tenantId,
    slug: tenantId,

    repositories: [
      {
        owner,
        name,
        cloneUrl: `https://github.com/${owner}/${name}.git`,
      },
    ],
    tracker: {
      adapter: "github-project",
      bindingId: `${tenantId}-project`,
      settings: {
        projectId: `${tenantId}-project`,
        token: `${tenantId}-token`,
      },
    },
    runtime: {
      driver: "local",
      workspaceRuntimeDir: join("/tmp", tenantId),
      projectRoot: process.cwd(),
    },
  };
}

async function createConfigFixture(input: {
  activeTenant: string;
  tenants: CliTenantConfig[];
}): Promise<string> {
  const configDir = await mkdtemp(join(tmpdir(), "cli-lifecycle-"));
  await writeFile(
    join(configDir, "config.json"),
    JSON.stringify(
      {
        activeTenant: input.activeTenant,
        token: `${input.activeTenant}-token`,
        tenants: input.tenants.map((tenant) => tenant.tenantId),
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  for (const tenant of input.tenants) {
    const tenantDir = join(configDir, "tenants", tenant.tenantId);
    await mkdir(tenantDir, { recursive: true });
    await writeFile(
      join(tenantDir, "tenant.json"),
      JSON.stringify(tenant, null, 2) + "\n",
      "utf8"
    );
  }

  return configDir;
}
