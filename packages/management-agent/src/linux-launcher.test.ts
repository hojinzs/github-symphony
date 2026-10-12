import { expect, it } from "vitest";
import {
  createLinuxProjectLaunchContext,
  type LinuxProjectLaunchRequest,
} from "./linux-launcher.js";
import type { SystemdCommand, SystemdRunner } from "./linux-systemd.js";

const agentGroup =
  "/user.slice/user-1000.slice/user@1000.service/app.slice/gh-symphony-agent.service";
const projectGroup =
  "/user.slice/user-1000.slice/user@1000.service/app.slice/gh-symphony-project-fixture.service";
function request(): LinuxProjectLaunchRequest {
  return {
    executable: "/opt/node",
    args: [
      "/opt/cli.js",
      "project",
      "start",
      "--project-dir",
      "/srv/literal $HOME % space",
      "--daemon",
    ],
    cwd: "/srv/project",
    deadline: Date.now() + 5000,
    environment: {
      PATH: "/usr/bin",
      HOME: "/home/operator",
      PROJECT_TOKEN: "project-only",
      GH_SYMPHONY_AGENT_CREDENTIAL: "private-agent",
      ALIAS: "private-agent",
      INVOCATION_ID: "agent-invocation",
    },
  };
}
function fixture(
  options: {
    submission?: number;
    state?: string;
    group?: string;
    current?: string;
    version?: string;
    mainStatus?: string;
  } = {}
) {
  const calls: SystemdCommand[] = [];
  const runner: SystemdRunner = async (command) => {
    calls.push(command);
    if (command.args.includes("--version"))
      return { exitCode: 0, stdout: options.version ?? "systemd 254\n" };
    if (command.args.includes("show-environment"))
      return {
        exitCode: 0,
        stdout:
          "PATH=/usr/bin\nGH_SYMPHONY_AGENT_CREDENTIAL=private-agent\nMANAGER_ONLY=another-secret\n",
      };
    if (command.executable === "/usr/bin/systemd-run")
      return { exitCode: options.submission ?? 0, stdout: "" };
    if (command.args.includes("gh-symphony-agent.service"))
      return {
        exitCode: 0,
        stdout: `ActiveState=active\nControlGroup=${agentGroup}\n`,
      };
    return {
      exitCode: 0,
      stdout: `ActiveState=${options.state ?? "active"}\nSubState=exited\nControlGroup=${options.group ?? projectGroup}\nExecMainCode=1\nExecMainStatus=${options.mainStatus ?? "0"}\n`,
    };
  };
  const context = createLinuxProjectLaunchContext({
    managementCredentials: ["private-agent"],
    runner,
    currentControlGroup: async () => options.current ?? agentGroup,
  });
  return { calls, context };
}
it("launches through an independent retained oneshot unit without credential or argument expansion", async () => {
  const { calls, context } = fixture();
  expect(await context.launchIsolatedProject(request())).toEqual({
    exitCode: 0,
  });
  const command = calls.find(
    (c) => c.executable === "/usr/bin/systemd-run" && c.args.includes("--user")
  )!;
  expect(command.args).toContain("--user");
  expect(command.args).toContain("--service-type=oneshot");
  expect(command.args).toContain("--remain-after-exit");
  expect(command.args).toContain("--expand-environment=no");
  expect(command.args).not.toContain("--scope");
  expect(command.args).not.toContain("--wait");
  expect(command.args).toContain("--property=KillMode=control-group");
  expect(command.args.slice(command.args.indexOf("/opt/node"))).toEqual(
    request().args.length ? ["/opt/node", ...request().args] : []
  );
  expect(command.args).toContain("--setenv=PROJECT_TOKEN");
  expect(command.args.join(" ")).not.toMatch(
    /private-agent|project-only|PartOf|BindsTo/
  );
  expect(command.environment).toMatchObject({ PROJECT_TOKEN: "project-only" });
  expect(command.environment).not.toHaveProperty("ALIAS");
  expect(command.environment).not.toHaveProperty("INVOCATION_ID");
  expect(
    command.args.find((a) => a.startsWith("--property=UnsetEnvironment="))
  ).toContain("MANAGER_ONLY");
  expect(
    command.args.find((a) => a.startsWith("--property=UnsetEnvironment="))
  ).toContain("GH_SYMPHONY_AGENT_CREDENTIAL");
});
it("rejects shared or nested control groups and does not launch outside the agent", async () => {
  for (const group of [
    agentGroup,
    `${agentGroup}/child`,
    "/user.slice",
    "",
    "/",
  ]) {
    const { context } = fixture({ group });
    expect(
      (await context.launchIsolatedProject(request())).exitCode
    ).toBeNull();
  }
  const { context, calls } = fixture({ current: "/foreground.scope" });
  expect((await context.launchIsolatedProject(request())).exitCode).toBeNull();
  expect(
    calls.some(
      (c) =>
        c.executable === "/usr/bin/systemd-run" && c.args.includes("--user")
    )
  ).toBe(false);
});
it("does not equate submission or failed execution with successful project startup", async () => {
  for (const options of [
    { submission: 1 },
    { state: "failed" },
    { mainStatus: "7" },
    { mainStatus: "" },
    { version: "systemd 252\n" },
  ]) {
    const { context } = fixture(options);
    expect((await context.launchIsolatedProject(request())).exitCode).not.toBe(
      0
    );
  }
});
it("honors expired deadlines and rejects relative paths before effects", async () => {
  const { context, calls } = fixture();
  expect(
    (
      await context.launchIsolatedProject({
        ...request(),
        deadline: Date.now() - 1,
      })
    ).exitCode
  ).toBeNull();
  expect(
    (await context.launchIsolatedProject({ ...request(), executable: "node" }))
      .exitCode
  ).toBeNull();
  expect(
    (await context.launchIsolatedProject({ ...request(), cwd: "relative" }))
      .exitCode
  ).toBeNull();
  expect(calls).toEqual([]);
});
it("uses unique project units across launches without stopping previous units", async () => {
  const { context, calls } = fixture();
  await context.launchIsolatedProject(request());
  await context.launchIsolatedProject(request());
  const units = calls
    .filter(
      (c) =>
        c.executable === "/usr/bin/systemd-run" && c.args.includes("--user")
    )
    .map((c) => c.args.find((a) => a.startsWith("--unit=")));
  expect(units).toHaveLength(2);
  expect(new Set(units).size).toBe(2);
  expect(
    units.every((u) =>
      /^--unit=gh-symphony-project-[a-f0-9-]+\.service$/.test(u!)
    )
  ).toBe(true);
  expect(calls.some((c) => c.args.includes("stop"))).toBe(false);
});
