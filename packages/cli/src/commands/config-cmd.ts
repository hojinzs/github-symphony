import { spawn } from "node:child_process";
import type { GlobalOptions } from "../index.js";
import {
  loadGlobalConfig,
  saveGlobalConfig,
  configFilePath,
  type CliGlobalConfig,
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
    process.stderr.write("No configuration found. Run 'gh-symphony init'.\n");
    process.exitCode = 1;
    return;
  }

  if (options.json) {
    process.stdout.write(JSON.stringify(config, null, 2) + "\n");
    return;
  }

  process.stdout.write(`Config: ${configFilePath(options.configDir)}\n\n`);
  process.stdout.write(`Active tenant:    ${config.activeTenant ?? "none"}\n`);
  process.stdout.write(
    `Tenants:          ${config.tenants.join(", ") || "none"}\n`
  );
}

// ── 7.2: config set ──────────────────────────────────────────────────────────

const VALID_KEYS: Record<string, { type: "string" | "number" }> = {
  "active-tenant": { type: "string" },
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

  const config =
    (await loadGlobalConfig(options.configDir)) ??
    ({
      activeTenant: null,
      tenants: [],
    } satisfies CliGlobalConfig);

  switch (key) {
    case "active-tenant":
      if (!config.tenants.includes(value)) {
        process.stderr.write(
          `Tenant "${value}" not found. Available: ${config.tenants.join(", ")}\n`
        );
        process.exitCode = 1;
        return;
      }
      config.activeTenant = value;
      break;
  }

  await saveGlobalConfig(options.configDir, config);
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
