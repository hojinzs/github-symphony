import { constants } from "node:fs";
import { open } from "node:fs/promises";
import {
  access,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  redactObservabilityDiagnosticsWithStats,
  redactObservabilityTextWithStats,
  type RedactionSummary,
} from "@gh-symphony/core";
import {
  configFilePath,
  orchestratorLogPath,
  projectConfigPath,
} from "../config.js";

export const SUPPORT_BUNDLE_LIMITS = {
  maxRuns: 3,
  maxLogBytes: 64 * 1024,
  maxLogLines: 500,
  maxBundleBytes: 5 * 1024 * 1024,
} as const;

export type SupportBundleMissing = {
  path: string;
  reason: string;
};

export type SupportBundleTruncation = {
  path: string;
  originalBytes?: number;
  writtenBytes: number;
  maxBytes?: number;
  maxLines?: number;
  reason: string;
};

export type SupportBundleManifest = {
  version: 1;
  createdAt: string;
  projectId: string;
  configDir: string;
  included: string[];
  missing: SupportBundleMissing[];
  redactions: RedactionSummary[];
  truncations: SupportBundleTruncation[];
  limits: typeof SUPPORT_BUNDLE_LIMITS;
  bundleBytes: {
    written: number;
    softMax: number;
    exceeded: boolean;
  };
};

export type SupportBundleSummary = {
  outputPath: string;
  projectId: string;
  includedCount: number;
  missingCount: number;
  redactionCount: number;
  redactionClasses: RedactionSummary[];
  truncationCount: number;
  manifestPath: string;
};

type SupportBundleInput = {
  configDir: string;
  projectId: string;
  repoRoot: string;
  outputPath?: string;
  doctorReport: unknown;
  now?: Date;
};

type BundleState = {
  root: string;
  manifest: SupportBundleManifest;
  writtenBytes: number;
};

type RecentRun = {
  runId: string;
  runDir: string;
  run: Record<string, unknown> | null;
  updatedAt: string;
  active: boolean;
};

export async function createSupportBundle(
  input: SupportBundleInput
): Promise<SupportBundleSummary> {
  const createdAt = (input.now ?? new Date()).toISOString();
  const root = resolveBundleRoot(input.outputPath, input.repoRoot, createdAt);
  await ensureWritableBundleRoot(root);

  const state: BundleState = {
    root,
    writtenBytes: 0,
    manifest: {
      version: 1,
      createdAt,
      projectId: input.projectId,
      configDir: resolve(input.configDir),
      included: [],
      missing: [],
      redactions: [],
      truncations: [],
      limits: SUPPORT_BUNDLE_LIMITS,
      bundleBytes: {
        written: 0,
        softMax: SUPPORT_BUNDLE_LIMITS.maxBundleBytes,
        exceeded: false,
      },
    },
  };

  await writeJsonArtifact(state, "doctor.json", input.doctorReport);
  await copyJsonArtifact(
    state,
    configFilePath(input.configDir),
    "config/config.json"
  );
  await copyJsonArtifact(
    state,
    projectConfigPath(input.configDir, input.projectId),
    "config/project.json"
  );
  await copyTextArtifact(
    state,
    join(input.repoRoot, "WORKFLOW.md"),
    "repo/WORKFLOW.md",
    { bounded: false }
  );

  const runtimeRoot = await resolveRuntimeArtifactRoot(
    input.configDir,
    input.projectId
  );
  await copyJsonArtifact(
    state,
    join(runtimeRoot, "status.json"),
    "runtime/status.json"
  );
  await copyJsonArtifact(
    state,
    join(runtimeRoot, "issues.json"),
    "runtime/issues.json"
  );
  await copyTextArtifact(
    state,
    orchestratorLogPath(input.configDir, input.projectId),
    "runtime/orchestrator.log.tail",
    { bounded: true }
  );

  const recentRuns = await listRecentRuns(input.configDir, input.projectId);
  if (recentRuns.length === 0) {
    state.manifest.missing.push({
      path: "runs",
      reason: "No run records were found for the selected project.",
    });
  }
  for (const recentRun of recentRuns) {
    const destinationDir = `runs/${sanitizePathSegment(recentRun.runId)}`;
    if (recentRun.run) {
      await writeJsonArtifact(
        state,
        `${destinationDir}/run.json`,
        recentRun.run
      );
    } else {
      state.manifest.missing.push({
        path: `${destinationDir}/run.json`,
        reason: "Run metadata is missing or unreadable.",
      });
    }
    await copyTextArtifact(
      state,
      join(recentRun.runDir, "events.ndjson"),
      `${destinationDir}/events.ndjson.tail`,
      { bounded: true }
    );
    await copyTextArtifact(
      state,
      join(recentRun.runDir, "worker.log"),
      `${destinationDir}/worker.log.tail`,
      { bounded: true }
    );
  }

  await writeManifest(state);
  return buildSummary(state);
}

function resolveBundleRoot(
  outputPath: string | undefined,
  repoRoot: string,
  createdAt: string
): string {
  if (outputPath) {
    return resolve(repoRoot, outputPath);
  }

  const timestamp = createdAt.replace(/[:.]/g, "").replace("T", "-");
  return resolve(repoRoot, `gh-symphony-support-bundle-${timestamp}`);
}

async function ensureWritableBundleRoot(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const target = await stat(root);
  if (!target.isDirectory()) {
    throw new Error(`Bundle output path is not a directory: ${root}`);
  }
  await access(root, constants.W_OK);
}

async function writeJsonArtifact(
  state: BundleState,
  relativePath: string,
  value: unknown
): Promise<void> {
  const redacted = redactObservabilityDiagnosticsWithStats(value);
  addRedactions(state, redacted.redactions);
  await writeBundleFile(
    state,
    relativePath,
    JSON.stringify(redacted.value, null, 2) + "\n"
  );
}

async function copyJsonArtifact(
  state: BundleState,
  sourcePath: string,
  destinationPath: string
): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(sourcePath, "utf8");
  } catch (error) {
    recordMissing(state, destinationPath, sourcePath, error);
    return;
  }

  try {
    const parsed = JSON.parse(raw);
    await writeJsonArtifact(state, destinationPath, parsed);
  } catch (error) {
    if (error instanceof SyntaxError) {
      recordMissing(state, destinationPath, sourcePath, error);
      return;
    }
    throw new Error(
      `Failed to redact/write JSON artifact ${sourcePath}: ${formatError(error)}`
    );
  }
}

async function copyTextArtifact(
  state: BundleState,
  sourcePath: string,
  destinationPath: string,
  options: { bounded: boolean }
): Promise<void> {
  let captured: CapturedText;
  try {
    captured = options.bounded
      ? await readBoundedTail(sourcePath)
      : { text: await readFile(sourcePath, "utf8"), truncated: false };
  } catch (error) {
    recordMissing(state, destinationPath, sourcePath, error);
    return;
  }

  const redacted = redactObservabilityTextWithStats(captured.text);
  addRedactions(state, redacted.redactions);
  await writeBundleFile(state, destinationPath, redacted.value);
  if (captured.truncated) {
    state.manifest.truncations.push({
      path: destinationPath,
      originalBytes: captured.originalBytes,
      writtenBytes: Buffer.byteLength(redacted.value, "utf8"),
      maxBytes: SUPPORT_BUNDLE_LIMITS.maxLogBytes,
      maxLines: SUPPORT_BUNDLE_LIMITS.maxLogLines,
      reason: captured.reason ?? "bounded_tail",
    });
  }
}

type CapturedText = {
  text: string;
  truncated: boolean;
  originalBytes?: number;
  reason?: string;
};

async function readBoundedTail(sourcePath: string): Promise<CapturedText> {
  const handle = await open(sourcePath, "r");
  try {
    const stats = await handle.stat();
    const start = Math.max(0, stats.size - SUPPORT_BUNDLE_LIMITS.maxLogBytes);
    const length = stats.size - start;
    const buffer = Buffer.alloc(length);
    if (length > 0) {
      await handle.read(buffer, 0, length, start);
    }

    let text = buffer.toString("utf8");
    let truncated = start > 0;
    const reasons: string[] = [];
    if (start > 0) {
      reasons.push("maxLogBytes");
      const firstNewline = text.indexOf("\n");
      if (firstNewline >= 0) {
        text = text.slice(firstNewline + 1);
      } else {
        reasons.push("partialLine");
      }
    }

    const lines = text.split(/\r?\n/);
    if (lines.length > SUPPORT_BUNDLE_LIMITS.maxLogLines) {
      text = lines.slice(-SUPPORT_BUNDLE_LIMITS.maxLogLines).join("\n");
      truncated = true;
      reasons.push("maxLogLines");
    }

    return {
      text,
      truncated,
      originalBytes: stats.size,
      reason: reasons.join(",") || undefined,
    };
  } finally {
    await handle.close();
  }
}

async function writeBundleFile(
  state: BundleState,
  relativePath: string,
  content: string
): Promise<void> {
  const target = resolveBundlePath(state.root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  state.writtenBytes += Buffer.byteLength(content, "utf8");
  state.manifest.included.push(relativePath);
}

async function writeManifest(state: BundleState): Promise<void> {
  if (!state.manifest.included.includes("manifest.json")) {
    state.manifest.included.push("manifest.json");
  }
  state.manifest.bundleBytes = {
    written: state.writtenBytes,
    softMax: SUPPORT_BUNDLE_LIMITS.maxBundleBytes,
    exceeded: state.writtenBytes > SUPPORT_BUNDLE_LIMITS.maxBundleBytes,
  };
  const target = resolveBundlePath(state.root, "manifest.json");
  await writeFile(
    target,
    JSON.stringify(state.manifest, null, 2) + "\n",
    "utf8"
  );
}

function resolveBundlePath(root: string, relativePath: string): string {
  const target = resolve(root, relativePath);
  const relativeTarget = relative(root, target);
  if (
    relativeTarget === "" ||
    relativeTarget.startsWith("..") ||
    relativeTarget.includes(`..${sep}`)
  ) {
    throw new Error(`Refusing to write outside bundle root: ${relativePath}`);
  }
  return target;
}

function recordMissing(
  state: BundleState,
  destinationPath: string,
  sourcePath: string,
  error: unknown
): void {
  state.manifest.missing.push({
    path: destinationPath,
    reason: `${sourcePath}: ${formatError(error)}`,
  });
}

function addRedactions(
  state: BundleState,
  redactions: RedactionSummary[]
): void {
  const existing = new Map(
    state.manifest.redactions.map((entry) => [entry.class, entry.count])
  );
  for (const redaction of redactions) {
    existing.set(
      redaction.class,
      (existing.get(redaction.class) ?? 0) + redaction.count
    );
  }
  state.manifest.redactions = Array.from(existing.entries())
    .map(([redactionClass, count]) => ({ class: redactionClass, count }))
    .sort((left, right) => left.class.localeCompare(right.class));
}

async function resolveRuntimeArtifactRoot(
  configDir: string,
  projectId: string
): Promise<string> {
  const candidates = [
    resolve(configDir),
    resolve(configDir, "projects", projectId),
  ];
  for (const candidate of candidates) {
    try {
      await access(join(candidate, "status.json"), constants.R_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return candidates[0]!;
}

async function listRecentRuns(
  configDir: string,
  projectId: string
): Promise<RecentRun[]> {
  const runsDirs = [
    resolve(configDir, "runs"),
    resolve(configDir, "projects", projectId, "runs"),
  ];
  const seen = new Set<string>();
  const runs: RecentRun[] = [];
  for (const runsDir of runsDirs) {
    let entries: string[];
    try {
      entries = await readdir(runsDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const runId = sanitizePathSegment(entry);
      if (seen.has(runId)) {
        continue;
      }
      const runDir = join(runsDir, entry);
      const runJsonPath = join(runDir, "run.json");
      let run: Record<string, unknown> | null = null;
      let updatedAt = "";
      let active = false;
      try {
        const raw = await readFile(runJsonPath, "utf8");
        run = JSON.parse(raw) as Record<string, unknown>;
        updatedAt =
          stringField(run, "updatedAt") ??
          stringField(run, "endedAt") ??
          stringField(run, "startedAt") ??
          "";
        const statusValue = stringField(run, "status");
        active = statusValue === "running" || statusValue === "retrying";
      } catch {
        try {
          const metadata = await stat(runDir);
          updatedAt = metadata.mtime.toISOString();
        } catch {
          updatedAt = "";
        }
      }
      seen.add(runId);
      runs.push({ runId, runDir, run, updatedAt, active });
    }
  }

  return runs
    .sort((left, right) => {
      if (left.active !== right.active) {
        return left.active ? -1 : 1;
      }
      return right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, SUPPORT_BUNDLE_LIMITS.maxRuns);
}

function stringField(
  value: Record<string, unknown>,
  key: string
): string | null {
  const field = value[key];
  return typeof field === "string" ? field : null;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function buildSummary(state: BundleState): SupportBundleSummary {
  const redactionCount = state.manifest.redactions.reduce(
    (sum, entry) => sum + entry.count,
    0
  );
  return {
    outputPath: state.root,
    projectId: state.manifest.projectId,
    includedCount: state.manifest.included.length,
    missingCount: state.manifest.missing.length,
    redactionCount,
    redactionClasses: state.manifest.redactions,
    truncationCount: state.manifest.truncations.length,
    manifestPath: join(state.root, "manifest.json"),
  };
}

function formatError(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return error instanceof Error ? error.message : String(error);
}
