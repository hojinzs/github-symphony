import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_AFTER_CREATE_HOOK_CONTENT } from "./default-hooks.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("default after_create hook", () => {
  it("creates an assigned branch that an external host fetch can publish", async () => {
    const root = await mkdtemp(join(tmpdir(), "default-after-create-"));
    temporaryDirectories.push(root);
    const origin = join(root, "origin.git");
    const seed = join(root, "seed");
    const repositoryPath = join(root, "workspace", "repository");
    const host = join(root, "host.git");
    const hookPath = join(root, "after_create.sh");

    git(["init", "--bare", "--initial-branch=main", origin]);
    git(["-C", origin, "config", "uploadpack.allowFilter", "true"]);
    git(["clone", origin, seed]);
    git(["-C", seed, "config", "user.name", "Test User"]);
    git(["-C", seed, "config", "user.email", "test@example.com"]);
    await writeFile(join(seed, "README.md"), "superseded blob\n");
    git(["-C", seed, "add", "README.md"]);
    git(["-C", seed, "commit", "-m", "seed old blob"]);
    await writeFile(join(seed, "README.md"), "populated\n");
    git(["-C", seed, "add", "README.md"]);
    git(["-C", seed, "commit", "-m", "replace blob"]);
    git(["-C", seed, "push", "origin", "main"]);
    git(["-C", seed, "checkout", "-b", "develop"]);
    await writeFile(join(seed, "BASE"), "develop\n");
    git(["-C", seed, "add", "BASE"]);
    git(["-C", seed, "commit", "-m", "develop"]);
    git(["-C", seed, "push", "origin", "develop"]);
    await writeFile(hookPath, DEFAULT_AFTER_CREATE_HOOK_CONTENT);
    await chmod(hookPath, 0o755);

    execFileSync(hookPath, [], {
      env: {
        ...process.env,
        SYMPHONY_REPOSITORY_CLONE_URL: `file://${origin}`,
        SYMPHONY_REPOSITORY_PATH: repositoryPath,
        SYMPHONY_ASSIGNED_BRANCH: "symphony/project/acme-platform-901",
        SYMPHONY_BASE_BRANCH: "develop",
      },
      stdio: "pipe",
    });

    expect(git(["-C", repositoryPath, "branch", "--show-current"]).trim()).toBe(
      "symphony/project/acme-platform-901"
    );
    await expect(
      readFile(join(repositoryPath, "README.md"), "utf8")
    ).resolves.toBe("populated\n");
    await expect(readFile(join(repositoryPath, "BASE"), "utf8")).resolves.toBe(
      "develop\n"
    );
    git(["init", "--bare", host]);
    git([
      "-C",
      host,
      "fetch",
      "--no-tags",
      repositoryPath,
      "refs/heads/symphony/project/acme-platform-901:refs/heads/symphony/project/acme-platform-901",
    ]);
    expect(
      git([
        "-C",
        host,
        "show",
        "refs/heads/symphony/project/acme-platform-901:README.md",
      ])
    ).toBe("populated\n");
    expect(
      git(["-C", repositoryPath, "config", "--get", "remote.origin.promisor"], {
        allowFailure: true,
      }).trim()
    ).toBe("");
  });
});

function git(args: string[], options: { allowFailure?: boolean } = {}): string {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (options.allowFailure) return "";
    throw error;
  }
}
