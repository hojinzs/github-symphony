import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureIssueWorkspaceRepository,
  loadWorkflowFile,
  renderIssueBranchName,
} from "./git.js";

let testDirectory: string;

beforeEach(async () => {
  testDirectory = await mkdtemp(join(tmpdir(), "orchestrator-git-"));
});

afterEach(async () => {
  await rm(testDirectory, { recursive: true, force: true });
});

describe("issue workspaces", () => {
  const repository = {
    owner: "acme",
    name: "platform",
    cloneUrl: "https://github.com/acme/platform.git",
  };

  it("creates only the repository directory for a new workspace", async () => {
    const issueWorkspacePath = join(testDirectory, "workspace");
    const repositoryDirectory = await ensureIssueWorkspaceRepository({
      repository,
      issueWorkspacePath,
      existingWorkspace: false,
    });

    expect(repositoryDirectory).toBe(join(issueWorkspacePath, "repository"));
    await expect(access(repositoryDirectory)).resolves.toBeUndefined();
    await expect(
      access(join(repositoryDirectory, ".git"))
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not initialize or replace a reused repository directory", async () => {
    const issueWorkspacePath = join(testDirectory, "workspace");
    const repositoryDirectory = join(issueWorkspacePath, "repository");
    await mkdir(repositoryDirectory, { recursive: true });
    await writeFile(join(repositoryDirectory, "keep"), "preserve\n");

    await expect(
      ensureIssueWorkspaceRepository({
        repository,
        issueWorkspacePath,
        existingWorkspace: true,
      })
    ).resolves.toBe(repositoryDirectory);
    await expect(
      readFile(join(repositoryDirectory, "keep"), "utf8")
    ).resolves.toBe("preserve\n");
  });

  it("supports a front matter branch template", () => {
    expect(
      renderIssueBranchName({
        template: "agents/{project_slug}/{sanitized_issue_id}",
        projectSlug: "project one",
        issueIdentifier: "acme/repo#42",
      })
    ).toBe("agents/project-one/acme-repo-42");
  });
});

describe("loadWorkflowFile", () => {
  it("rejects a custom auth name declared by the selected tracker adapter", async () => {
    const workflowPath = join(testDirectory, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---
tracker:
  kind: file
runtime:
  kind: custom
  command: node
  auth:
    env: TRACKER_SECRET
---
Prompt`,
      "utf8"
    );

    const resolution = await loadWorkflowFile(workflowPath, process.env, {
      secretEnvironmentNames: () => ["TRACKER_SECRET"],
    });
    expect(resolution).toMatchObject({
      isValid: false,
      validationError: expect.stringMatching(
        /runtime\.auth\.env.*reserved credential.*TRACKER_SECRET/i
      ),
    });
  });

  it("uses the selected tracker adapter for provider validation", async () => {
    const workflowPath = join(testDirectory, "WORKFLOW.md");
    const validateProviderConfig = vi.fn(() => []);
    await writeFile(
      workflowPath,
      `---
tracker:
  kind: file
  provider:
    issues_path: /tmp/issues.json
    state_field: Status
  active_states:
    - Ready
  terminal_states:
    - Done
codex:
  command: codex
---
Prompt`,
      "utf8"
    );

    const resolution = await loadWorkflowFile(workflowPath, process.env, {
      validateProviderConfig,
    });
    expect(resolution.isValid).toBe(true);
    expect(validateProviderConfig).toHaveBeenCalledWith(
      { issues_path: "/tmp/issues.json", state_field: "Status" },
      {
        rawProvider: { issues_path: "/tmp/issues.json", state_field: "Status" },
      }
    );
  });
});
