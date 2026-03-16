import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { GlobalOptions } from "../index.js";
import { runCli as orchestratorRunCli } from "@gh-symphony/orchestrator";
import {
  resolveRuntimeRoot,
  syncProjectToRuntime,
} from "../orchestrator-runtime.js";
import {
  handleMissingManagedProjectConfig,
  resolveManagedProjectConfig,
} from "../project-selection.js";

type RecoverCandidate = {
  runId: string;
  issueIdentifier: string;
  status: string;
  reason: string;
};

function parseRecoverArgs(args: string[]): {
  dryRun: boolean;
  projectId?: string;
} {
  const parsed: { dryRun: boolean; projectId?: string } = { dryRun: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--dry-run") {
      parsed.dryRun = true;
    }
    if (arg === "--project" || arg === "--project-id") {
      parsed.projectId = args[i + 1];
      i += 1;
    }
  }
  return parsed;
}

const handler = async (
  args: string[],
  options: GlobalOptions
): Promise<void> => {
  const parsed = parseRecoverArgs(args);

  const projectConfig = await resolveManagedProjectConfig({
    configDir: options.configDir,
    requestedProjectId: parsed.projectId,
  });
  if (!projectConfig) {
    handleMissingManagedProjectConfig();
    return;
  }

  const runtimeRoot = resolveRuntimeRoot(options.configDir);
  const projectId = projectConfig.projectId;
  await syncProjectToRuntime(options.configDir, projectConfig);

  if (parsed.dryRun) {
    process.stdout.write("Dry run — scanning for stalled runs...\n");
    const candidates = await listRecoverCandidates(runtimeRoot, projectId);
    if (options.json) {
      process.stdout.write(JSON.stringify(candidates, null, 2) + "\n");
      return;
    }
    if (candidates.length === 0) {
      process.stdout.write("No recoverable runs found.\n");
      return;
    }
    for (const candidate of candidates) {
      process.stdout.write(
        `${candidate.issueIdentifier} (${candidate.runId}) — ${candidate.reason}\n`
      );
    }
    return;
  }

  process.stdout.write("Recovering stalled runs...\n");
  await orchestratorRunCli([
    "recover",
    "--runtime-root",
    runtimeRoot,
    "--project-id",
    projectId,
  ]);
};

export default handler;

async function listRecoverCandidates(
  runtimeRoot: string,
  projectId: string
): Promise<RecoverCandidate[]> {
  const runsDir = join(runtimeRoot, "orchestrator", "runs");
  const candidates: RecoverCandidate[] = [];

  let entries: string[] = [];
  try {
    entries = await readdir(runsDir);
  } catch {
    return candidates;
  }

  for (const entry of entries) {
    const runPath = join(runsDir, entry, "run.json");
    try {
      const raw = await readFile(runPath, "utf8");
      const run = JSON.parse(raw) as {
        runId: string;
        projectId: string;
        issueIdentifier: string;
        status: string;
        processId: number | null;
        startedAt: string | null;
        nextRetryAt: string | null;
      };

      if (run.projectId !== projectId) {
        continue;
      }

      const reason = detectRecoveryReason(run);
      if (!reason) {
        continue;
      }

      candidates.push({
        runId: run.runId,
        issueIdentifier: run.issueIdentifier,
        status: run.status,
        reason,
      });
    } catch {
      // Skip malformed or partial run records.
    }
  }

  return candidates;
}

function detectRecoveryReason(run: {
  status: string;
  processId: number | null;
  startedAt: string | null;
  nextRetryAt: string | null;
}): string | null {
  if (run.processId) {
    const startedAt = run.startedAt ? new Date(run.startedAt).getTime() : 0;
    const runningForMs = Date.now() - startedAt;
    if (isProcessRunning(run.processId) && runningForMs > 30 * 60 * 1000) {
      return "worker appears stuck";
    }
    if (!isProcessRunning(run.processId)) {
      return "worker process is no longer running";
    }
  }

  if (
    run.status === "retrying" &&
    run.nextRetryAt &&
    new Date(run.nextRetryAt).getTime() <= Date.now()
  ) {
    return "retry window has elapsed";
  }

  return null;
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
