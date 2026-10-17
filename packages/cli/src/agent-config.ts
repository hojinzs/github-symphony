import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";

export interface AgentHostConfig {
  version: 1;
  dataDirectory: string;
  projectConfigDir: string;
  nodePath: string;
  cliPath: string;
  caFile?: string;
}
export function defaultAgentConfigPath(): string {
  return join(homedir(), ".gh-symphony-agent", "config.json");
}
function parseConfig(value: unknown): AgentHostConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid agent config");
  const config = value as Record<string, unknown>;
  const allowed = [
    "version",
    "dataDirectory",
    "projectConfigDir",
    "nodePath",
    "cliPath",
    "caFile",
  ];
  if (
    config.version !== 1 ||
    Object.keys(config).some((key) => !allowed.includes(key))
  )
    throw new Error("Unsupported agent config");
  for (const key of allowed.slice(1)) {
    if (key === "caFile" && config[key] === undefined) continue;
    const path = config[key];
    if (
      typeof path !== "string" ||
      !isAbsolute(path) ||
      [...path].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      )
    )
      throw new Error(
        "Agent config paths must be absolute without control characters"
      );
  }
  return config as unknown as AgentHostConfig;
}
/** Private local configuration contains host paths only; credentials live in AgentRegistry. */
export async function loadAgentConfig(
  path: string,
  defaults?: { projectConfigDir: string; cliPath: string }
): Promise<AgentHostConfig> {
  path = resolve(path);
  if (defaults) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const metadata = await lstat(dirname(path));
    if (
      !metadata.isDirectory() ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o777) !== 0o700
    )
      throw new Error("Agent config directory must be private and user-owned");
    const config = parseConfig({
      version: 1,
      dataDirectory: await realpath(dirname(path)),
      projectConfigDir: resolve(defaults.projectConfigDir),
      nodePath: await realpath(process.execPath),
      cliPath: await realpath(defaults.cliPath),
    });
    try {
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(config, null, 2) + "\n");
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(
        "Agent config missing; run agent setup or create a private config file"
      );
    throw new Error("Agent config must be a private regular file");
  }
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 16384
    )
      throw new Error("Agent config must be a private user-owned regular file");
    return parseConfig(JSON.parse(await file.readFile("utf8")));
  } finally {
    await file.close();
  }
}
