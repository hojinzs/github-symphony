import type { GlobalOptions } from "../index.js";
import { listInstances } from "../instances.js";

export default async function instancesCommand(
  _args: string[],
  options: GlobalOptions
): Promise<void> {
  const instances = await listInstances();
  if (options.json) {
    process.stdout.write(JSON.stringify(instances, null, 2) + "\n");
    return;
  }
  if (instances.length === 0) {
    process.stdout.write("No registered orchestrator instances.\n");
    return;
  }
  const rows = [
    [
      "STATUS",
      "PROJECT",
      "REPOSITORY",
      "WORKSPACE",
      "PID",
      "UPTIME",
      "PHASE",
      "ENDPOINT",
    ],
    ...instances.map((instance) => [
      instance.status,
      instance.projectId,
      instance.repo,
      instance.workspacePath,
      String(instance.pid),
      formatUptime(instance.uptimeMs),
      instance.phase ?? "-",
      instance.endpoint ?? "-",
    ]),
  ];
  const widths = rows[0]!.map((_, index) =>
    Math.max(...rows.map((row) => row[index]!.length))
  );
  process.stdout.write(
    rows
      .map((row) =>
        row
          .map((cell, index) => cell.padEnd(widths[index]!))
          .join("  ")
          .trimEnd()
      )
      .join("\n") + "\n"
  );
}

function formatUptime(uptimeMs: number): string {
  const seconds = Math.floor(uptimeMs / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${Math.floor((seconds % 86_400) / 3_600)}h`;
  return `${hours}h ${minutes}m`;
}
