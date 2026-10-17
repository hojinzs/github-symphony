import {
  realpath,
  mkdtemp,
  rm,
  chmod,
  symlink,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { loadAgentConfig } from "./agent-config.js";

it("creates private absolute host config once and rejects unsafe files without overwriting", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-config-")));
  const path = join(root, "agent", "config.json");
  try {
    const config = await loadAgentConfig(path, {
      projectConfigDir: join(root, "projects"),
      cliPath: process.argv[1]!,
    });
    expect(config.dataDirectory).toBe(join(root, "agent"));
    const before = await readFile(path, "utf8");
    expect(await loadAgentConfig(path)).toEqual(config);
    expect(await readFile(path, "utf8")).toBe(before);
    await chmod(path, 0o644);
    await expect(loadAgentConfig(path)).rejects.toThrow(/private|user/);
    await chmod(path, 0o600);
    await symlink(path, join(root, "alias"));
    await expect(loadAgentConfig(join(root, "alias"))).rejects.toThrow(
      /regular|private/
    );
    await expect(loadAgentConfig(join(root, "missing"))).rejects.toThrow(
      /setup|config/i
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
