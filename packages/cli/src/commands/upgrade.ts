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
  platform?: NodeJS.Platform;
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

function resolvePackageManagerExecutable(
  command: PackageManager | "npm",
  platform = process.platform
): string {
  return platform === "win32" ? `${command}.cmd` : command;
}

export async function fetchLatestCliVersion(
  deps?: Pick<UpgradeDeps, "execFileImpl" | "platform">
): Promise<string> {
  const runExecFile = deps?.execFileImpl ?? execFileAsync;
  const { stdout } = await runExecFile(
    resolvePackageManagerExecutable("npm", deps?.platform),
    [
      "view",
      PACKAGE_NAME,
      "dist-tags.latest",
      "--json",
    ]
  );

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
  deps?: Pick<UpgradeDeps, "execFileImpl" | "platform">
): Promise<PackageManager> {
  const runExecFile = deps?.execFileImpl ?? execFileAsync;

  try {
    const { stdout } = await runExecFile(
      resolvePackageManagerExecutable("npm", deps?.platform),
      ["prefix", "-g"]
    );
    return stdout.toLowerCase().includes("pnpm") ? "pnpm" : "npm";
  } catch {
    return "npm";
  }
}

function packageManagerCommand(
  manager: PackageManager,
  platform?: NodeJS.Platform
): string[] {
  if (manager === "pnpm") {
    return [
      resolvePackageManagerExecutable("pnpm", platform),
      "add",
      "-g",
      `${PACKAGE_NAME}@latest`,
    ];
  }

  return [
    resolvePackageManagerExecutable("npm", platform),
    "install",
    "-g",
    `${PACKAGE_NAME}@latest`,
  ];
}

function pipeInstallOutput(child: ChildProcess): void {
  child.stdout?.on("data", (chunk: string | Uint8Array) => {
    process.stderr.write(chunk);
  });
  child.stderr?.on("data", (chunk: string | Uint8Array) => {
    process.stderr.write(chunk);
  });
}

export async function runUpgradeInstall(
  manager: PackageManager,
  deps?: Pick<UpgradeDeps, "platform" | "spawnImpl">,
  jsonOutput = false
): Promise<void> {
  const spawnCommand = deps?.spawnImpl ?? spawn;
  const [command, ...args] = packageManagerCommand(manager, deps?.platform);

  await new Promise<void>((resolve, reject) => {
    const child = (
      jsonOutput
        ? spawnCommand(command, args, {
            stdio: ["ignore", "pipe", "pipe"],
          })
        : spawnCommand(command, args, {
            stdio: "inherit",
          })
    ) as ChildProcess;

    if (jsonOutput) {
      pipeInstallOutput(child);
    }

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

  await runUpgradeInstall(manager, deps, options.json);

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
