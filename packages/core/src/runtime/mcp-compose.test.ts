import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { composeMcpServers, McpConfigError } from "./mcp-compose.js";

const roots: string[] = [];

async function fixture(): Promise<{
  root: string;
  repo: string;
  project: string;
  home: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "mcp-compose-"));
  roots.push(root);
  const repo = join(root, "repo");
  const project = join(root, "project");
  const home = join(root, "home");
  await Promise.all([mkdir(repo), mkdir(project), mkdir(home)]);
  await mkdir(join(home, ".gh-symphony"));
  return { root, repo, project, home };
}

afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  )
);

describe("composeMcpServers", () => {
  it("orders repo, global, project, then immutable builtins", async () => {
    const { repo, project, home } = await fixture();
    await writeFile(
      join(repo, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          shared: { command: "repo" },
          repo: { command: "repo" },
          github_graphql: { command: "repo" },
        },
      })
    );
    await writeFile(
      join(home, ".gh-symphony", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          shared: { command: "global" },
          global: { command: "global" },
        },
      })
    );
    await writeFile(
      join(project, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          shared: { command: "project" },
          project: { command: "project" },
          github_graphql: { command: "project" },
        },
      })
    );
    expect(
      composeMcpServers({
        repositoryDir: repo,
        projectDir: project,
        homeDir: home,
        trustRepoConfig: true,
        builtins: { github_graphql: { command: "builtin" } },
      })
    ).toMatchObject({
      shared: { command: "project" },
      repo: { command: "repo" },
      global: { command: "global" },
      project: { command: "project" },
      github_graphql: { command: "builtin" },
    });
  });

  it("does not load the repository sidecar without explicit trust", async () => {
    const { repo, home } = await fixture();
    await writeFile(
      join(repo, ".mcp.json"),
      JSON.stringify({ mcpServers: { repo: { command: "repo" } } })
    );
    expect(
      composeMcpServers({ repositoryDir: repo, homeDir: home })
    ).not.toHaveProperty("repo");
    expect(
      composeMcpServers({
        repositoryDir: repo,
        homeDir: home,
        trustRepoConfig: true,
      })
    ).toMatchObject({ repo: { command: "repo" } });
  });

  it("rejects literal sidecar env values and resolves $VAR from project .env", async () => {
    const { repo, project, home } = await fixture();
    await writeFile(join(project, ".env"), "SIDE_TOKEN=from-project\n");
    await writeFile(
      join(project, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          valid: { command: "tool", env: { TOKEN: "$SIDE_TOKEN" } },
          invalid: { command: "tool", env: { TOKEN: "secret" } },
        },
      })
    );
    expect(() =>
      composeMcpServers({
        repositoryDir: repo,
        projectDir: project,
        homeDir: home,
      })
    ).toThrow(McpConfigError);
    await writeFile(
      join(project, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          valid: { command: "tool", env: { TOKEN: "$SIDE_TOKEN" } },
        },
      })
    );
    expect(
      composeMcpServers({
        repositoryDir: repo,
        projectDir: project,
        homeDir: home,
      })
    ).toMatchObject({ valid: { env: { TOKEN: "from-project" } } });
  });
});
