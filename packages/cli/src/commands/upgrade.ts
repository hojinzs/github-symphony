import { readFileSync } from "node:fs";
import { execFile as execFileCallback, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import type { GlobalOptions } from "../index.js";

declare const __CLI_VERSION__: string;

const PACKAGE_NAME = "@gh-symphony/cli";

type PackageManager = "npm" | "pnpm";
type ExecFileResult = { stdout: string; stderr: string };
type ExecFileImpl = (
  file: string,
  args: readonly string[],
  callback: (error: Error | null, stdout: string, stderr: string) => void
) => void;

type UpgradeDeps = {
  execFileImpl?: (
    file: string,
    args: readonly string[]
  ) => Promise<ExecFileResult>;
  currentVersion?: string;
  spawnImpl?: typeof spawn;
};

function execFileAsync(
  file: string,
  args: readonly string[],
  execFileImpl: ExecFileImpl = execFileCallback
): Promise<ExecFileResult> {
  return new Promise((resolve, reject) => {
    execFileImpl(file, args, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function resolveCurrentCliVersion(): string {
  if (typeof __CLI_VERSION__ === "string" && __CLI_VERSION__.length > 0) {
    return __CLI_VERSION__;
  }

  const pkg = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8")
  ) as { version?: unknown };

  if (typeof pkg.version === "string" && pkg.version.length > 0) {
    return pkg.version;
  }

  throw new Error("Unable to determine the current CLI version.");
}

export async function fetchLatestCliVersion(
  deps?: Pick<UpgradeDeps, "execFileImpl">
): Promise<string> {
  const runExecFile = deps?.execFileImpl ?? execFileAsync;
  const { stdout } = await runExecFile("npm", [
    "view",
    PACKAGE_NAME,
    "dist-tags.latest",
    "--json",
  ]);

  const raw = stdout.trim();
  if (raw.length === 0) {
    throw new Error("Failed to resolve the latest CLI version from npm.");
  }

  const parsed = JSON.parse(raw) as unknown;
  if (typeof parsed !== "string" || parsed.length === 0) {
    throw new Error("npm returned an invalid latest version response.");
  }

  return parsed;
}

export async function detectGlobalPackageManager(
  deps?: Pick<UpgradeDeps, "execFileImpl">
): Promise<PackageManager> {
  const runExecFile = deps?.execFileImpl ?? execFileAsync;

  try {
    const { stdout } = await runExecFile("npm", ["prefix", "-g"]);
    return stdout.toLowerCase().includes("pnpm") ? "pnpm" : "npm";
  } catch {
    return "npm";
  }
}

function packageManagerCommand(manager: PackageManager): string[] {
  if (manager === "pnpm") {
    return ["pnpm", "add", "-g", `${PACKAGE_NAME}@latest`];
  }

  return ["npm", "install", "-g", `${PACKAGE_NAME}@latest`];
}

export async function runUpgradeInstall(
  manager: PackageManager,
  deps?: Pick<UpgradeDeps, "spawnImpl">
): Promise<void> {
  const spawnCommand = deps?.spawnImpl ?? spawn;
  const [command, ...args] = packageManagerCommand(manager);

  await new Promise<void>((resolve, reject) => {
    const child = spawnCommand(command, args, {
      stdio: "inherit",
    }) as ChildProcess;

    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(`${command} exited with code ${code ?? "unknown"}.`)
      );
    });
  });
}

export async function runUpgradeCommand(
  options: GlobalOptions,
  deps?: UpgradeDeps
): Promise<void> {
  const latestVersion = await fetchLatestCliVersion(deps);
  const currentVersion = deps?.currentVersion ?? resolveCurrentCliVersion();

  if (currentVersion === latestVersion) {
    if (options.json) {
      process.stdout.write(
        JSON.stringify({
          status: "up_to_date",
          currentVersion,
          latestVersion,
          packageManager: null,
        }) + "\n"
      );
    } else {
      process.stdout.write(`Already up to date (v${currentVersion})\n`);
    }
    return;
  }

  const manager = await detectGlobalPackageManager(deps);

  if (!options.json) {
    process.stdout.write(
      `Upgrading ${PACKAGE_NAME} from v${currentVersion} to v${latestVersion} using ${manager}...\n`
    );
  }

  await runUpgradeInstall(manager, deps);

  if (options.json) {
    process.stdout.write(
      JSON.stringify({
        status: "upgraded",
        previousVersion: currentVersion,
        latestVersion,
        packageManager: manager,
      }) + "\n"
    );
  } else {
    process.stdout.write(`Upgrade complete (v${latestVersion})\n`);
  }
}

const handler = async (
  _args: string[],
  options: GlobalOptions
): Promise<void> => {
  await runUpgradeCommand(options);
};

export default handler;
