import type { GlobalOptions } from "../index.js";
import { listInstances } from "../instances.js";

export default async function instancesCommand(_args: string[], options: GlobalOptions): Promise<void> {
  const instances = await listInstances();
  if (options.json) { process.stdout.write(JSON.stringify(instances, null, 2) + "\n"); return; }
  if (instances.length === 0) { process.stdout.write("No registered orchestrator instances.\n"); return; }
  process.stdout.write(["STATUS  PROJECT  REPOSITORY  WORKSPACE  PID  ENDPOINT", ...instances.map((i) => `${i.status}  ${i.projectId}  ${i.repo}  ${i.workspacePath}  ${i.pid}  ${i.endpoint ?? "-"}`)].join("\n") + "\n");
}
