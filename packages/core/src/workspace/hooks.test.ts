import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildHookExecutionEnv,
  executeWorkspaceHook,
  MAX_HOOK_OUTPUT_BYTES,
  validateWorkflowHookPaths,
} from "./hooks.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0, tempDirs.length)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe("executeWorkspaceHook", () => {
  it("skips WORKFLOW.md hooks unless explicit trust is granted", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "hook-untrusted-"));
    tempDirs.push(repositoryPath);

    const result = await executeWorkspaceHook({
      kind: "after_create",
      hooks: {
        afterCreate:
          'printf "unsafe" > "$SYMPHONY_REPOSITORY_PATH/.hook-result"',
        beforeRun: null,
        afterRun: null,
        beforeRemove: null,
      },
      repositoryPath,
      env: {
        SYMPHONY_REPOSITORY_PATH: repositoryPath,
      },
      timeoutMs: 5000,
    });

    expect(result.outcome).toBe("skipped");
    await expect(
      readFile(join(repositoryPath, ".hook-result"), "utf8")
    ).rejects.toThrow();
  });

  it("times out long-running hook commands", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "hook-timeout-"));
    tempDirs.push(repositoryPath);
    await writeFile(
      join(repositoryPath, "sleep.sh"),
      "#!/usr/bin/env bash\nsleep 1\n",
      "utf8"
    );
    await chmod(join(repositoryPath, "sleep.sh"), 0o755);

    const result = await executeWorkspaceHook({
      kind: "before_run",
      hooks: {
        afterCreate: null,
        beforeRun: "sleep.sh",
        afterRun: null,
        beforeRemove: null,
      },
      repositoryPath,
      env: {},
      trusted: true,
      timeoutMs: 10,
    });

    expect(result.outcome).toBe("timeout");
  });

  it("drains large stdout without waiting for the timeout", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "hook-stdout-"));
    tempDirs.push(repositoryPath);
    await writeFile(
      join(repositoryPath, "large-output.sh"),
      "#!/usr/bin/env bash\nhead -c 131072 /dev/zero\n",
      "utf8"
    );
    await chmod(join(repositoryPath, "large-output.sh"), 0o755);

    const result = await executeWorkspaceHook({
      kind: "before_run",
      hooks: {
        afterCreate: null,
        beforeRun: "large-output.sh",
        afterRun: null,
        beforeRemove: null,
      },
      repositoryPath,
      env: {},
      trusted: true,
      timeoutMs: 1_000,
    });

    expect(result.outcome).toBe("success");
  });

  it("bounds failed hook stderr diagnostics", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "hook-stderr-"));
    tempDirs.push(repositoryPath);
    await writeFile(
      join(repositoryPath, "large-error.sh"),
      "#!/usr/bin/env bash\nyes '가나다라' | head -c 8192 >&2\nexit 1\n",
      "utf8"
    );
    await chmod(join(repositoryPath, "large-error.sh"), 0o755);

    const result = await executeWorkspaceHook({
      kind: "before_run",
      hooks: {
        afterCreate: null,
        beforeRun: "large-error.sh",
        afterRun: null,
        beforeRemove: null,
      },
      repositoryPath,
      env: {},
      trusted: true,
      timeoutMs: 1_000,
    });

    expect(result.outcome).toBe("failure");
    expect(Buffer.byteLength(result.error ?? "", "utf8")).toBeLessThanOrEqual(
      MAX_HOOK_OUTPUT_BYTES
    );
    expect(result.error).not.toContain("�");
  });

  it("supports repository-relative hook paths via bash execution", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "hook-path-"));
    tempDirs.push(repositoryPath);
    await mkdir(join(repositoryPath, "hooks"), { recursive: true });
    await writeFile(
      join(repositoryPath, "hooks", "after_run.sh"),
      '#!/usr/bin/env bash\nprintf "path-ok" > "$SYMPHONY_REPOSITORY_PATH/.path-hook"\n',
      "utf8"
    );
    await chmod(join(repositoryPath, "hooks", "after_run.sh"), 0o755);

    const result = await executeWorkspaceHook({
      kind: "after_run",
      hooks: {
        afterCreate: null,
        beforeRun: null,
        afterRun: "hooks/after_run.sh",
        beforeRemove: null,
      },
      repositoryPath,
      env: {
        SYMPHONY_REPOSITORY_PATH: repositoryPath,
      },
      trusted: true,
      timeoutMs: 5000,
    });

    expect(result.outcome).toBe("success");
    expect(await readFile(join(repositoryPath, ".path-hook"), "utf8")).toBe(
      "path-ok"
    );
  });

  it("rejects approved hooks that contain shell syntax", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "hook-shell-syntax-"));
    tempDirs.push(repositoryPath);

    const result = await executeWorkspaceHook({
      kind: "after_run",
      hooks: {
        afterCreate: null,
        beforeRun: null,
        afterRun: "hooks/after_run.sh; echo injected",
        beforeRemove: null,
      },
      repositoryPath,
      env: {},
      trusted: true,
      timeoutMs: 5000,
    });

    expect(result.outcome).toBe("failure");
    expect(result.error).toContain("without shell syntax");
  });

  it("builds hook env from an allowlist and strips secrets", () => {
    expect(
      buildHookExecutionEnv(
        {
          PATH: "/bin",
          SYMPHONY_REPOSITORY_PATH: "/repo",
          STAGING_API_HOST: "https://staging.example.com",
          GITHUB_GRAPHQL_TOKEN: "ghs_secret",
          SSH_AUTH_SOCK: "/tmp/agent.sock",
        },
        ["STAGING_API_HOST"]
      )
    ).toEqual({
      PATH: "/bin",
      SYMPHONY_REPOSITORY_PATH: "/repo",
      STAGING_API_HOST: "https://staging.example.com",
    });
  });
});

describe("validateWorkflowHookPaths", () => {
  it("reports absent and non-executable hook scripts with resolved paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "hook-validation-"));
    tempDirs.push(root);
    await mkdir(join(root, "hooks"));
    await writeFile(join(root, "hooks", "before-run.sh"), "#!/bin/sh\n", {
      mode: 0o644,
    });

    const result = await validateWorkflowHookPaths(
      {
        afterCreate: "hooks/missing.sh",
        beforeRun: "hooks/before-run.sh",
        afterRun: "echo ready",
        beforeRemove: null,
      },
      root
    );

    expect(result).toMatchObject({
      inline: 1,
      checked: [],
      problems: [
        {
          hook: "after_create",
          path: join(root, "hooks", "missing.sh"),
          reason: "missing",
        },
        {
          hook: "before_run",
          path: join(root, "hooks", "before-run.sh"),
          reason: "not_executable",
        },
      ],
    });
  });

  it("accepts a symlink to an executable regular file", async () => {
    const root = await mkdtemp(join(tmpdir(), "hook-validation-symlink-"));
    tempDirs.push(root);
    await mkdir(join(root, "hooks"));
    const target = join(root, "provisioned-hook.sh");
    await writeFile(target, "#!/bin/sh\n", { mode: 0o755 });
    await symlink(target, join(root, "hooks", "after-create.sh"));

    const result = await validateWorkflowHookPaths(
      {
        afterCreate: "hooks/after-create.sh",
        beforeRun: null,
        afterRun: null,
        beforeRemove: null,
      },
      root
    );

    expect(result.problems).toEqual([]);
    expect(result.checked).toEqual([
      expect.objectContaining({
        hook: "after_create",
        path: join(root, "hooks", "after-create.sh"),
      }),
    ]);
  });
});
