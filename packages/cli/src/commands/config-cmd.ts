import { spawn } from "node:child_process";
import type { GlobalOptions } from "../index.js";
import {
  loadGlobalConfig,
  updateGlobalConfig,
  configFilePath,
} from "../config.js";

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => {
  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case "show":
      await configShow(options);
      break;
    case "set":
      await configSet(rest, options);
      break;
    case "edit":
      await configEdit(options);
      break;
    default:
      process.stderr.write("Usage: gh-symphony config <show|set|edit>\n");
      process.exitCode = 2;
  }
};

export default handler;

// ── 7.1: config show ─────────────────────────────────────────────────────────

async function configShow(options: GlobalOptions): Promise<void> {
  const config = await loadGlobalConfig(options.configDir);
  if (!config) {
    process.stderr.write(
      "No configuration found. Run 'gh-symphony workflow init'.\n"
    );
    process.exitCode = 1;
    return;
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(config, null, 2) + "\n");
    return;
  }

  process.stdout.write(`Config: ${configFilePath(options.configDir)}\n\n`);
  process.stdout.write(
    `Active project:    ${config.activeProject ?? "none"}\n`
  );
  process.stdout.write(
    `Projects:         ${config.projects.join(", ") || "none"}\n`
  );
}

// ── 7.2: config set ──────────────────────────────────────────────────────────

const VALID_KEYS: Record<string, { type: "string" | "number" }> = {
  "active-project": { type: "string" },
};

async function configSet(
  args: string[],
  options: GlobalOptions
): Promise<void> {
  const [key, value] = args;
  if (!key || value === undefined) {
    process.stderr.write("Usage: gh-symphony config set <key> <value>\n");
    process.stderr.write(`Valid keys: ${Object.keys(VALID_KEYS).join(", ")}\n`);
    process.exitCode = 2;
    return;
  }

  const keyDef = VALID_KEYS[key];
  if (!keyDef) {
    process.stderr.write(
      `Unknown config key: ${key}\nValid keys: ${Object.keys(VALID_KEYS).join(", ")}\n`
    );
    process.exitCode = 2;
    return;
  }

  let availableProjects: string[] = [];
  const updated = await updateGlobalConfig(options.configDir, (config) => {
    availableProjects = config.projects;
    switch (key) {
      case "active-project":
        if (!config.projects.includes(value)) {
          return null;
        }
        return { ...config, activeProject: value };
      default:
        return null;
    }
  });
  if (!updated) {
    process.stderr.write(
      `Project "${value}" not found. Available: ${availableProjects.join(", ")}\n`
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`Set ${key} = ${value}\n`);
}

// ── 7.3: config edit ─────────────────────────────────────────────────────────

async function configEdit(options: GlobalOptions): Promise<void> {
  const editor = process.env.EDITOR || process.env.VISUAL || "vi";
  const path = configFilePath(options.configDir);

  const child = spawn(editor, [path], {
    stdio: "inherit",
  });

  await new Promise<void>((resolve, reject) => {
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Editor exited with code ${code}`));
      }
    });
  });
}
