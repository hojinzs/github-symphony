import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireProjectLock,
  releaseProjectLock,
  type ProjectLockHandle,
} from "@gh-symphony/orchestrator";

const PROJECT_IDENTITY_LOCK_NAMESPACE = "gh-symphony-project-locks";

export type ProjectStartLocks = {
  projectLock: ProjectLockHandle;
  identityLock?: ProjectLockHandle;
};

export async function resolveProjectIdentityLock(input: {
  projectDir: string;
  temporaryDirectory?: string;
}): Promise<{
  runtimeRoot: string;
  projectId: string;
  canonicalProjectDir: string;
}> {
  const canonicalProjectDir = await realpath(input.projectDir);
  const digest = createHash("sha256").update(canonicalProjectDir).digest("hex");
  const userNamespace =
    typeof process.getuid === "function" ? String(process.getuid()) : "user";
  return {
    runtimeRoot: join(
      input.temporaryDirectory ?? tmpdir(),
      `${PROJECT_IDENTITY_LOCK_NAMESPACE}-${userNamespace}`
    ),
    projectId: digest,
    canonicalProjectDir,
  };
}

export async function acquireProjectStartLocks(input: {
  runtimeRoot: string;
  projectId: string;
  projectDir?: string;
}): Promise<ProjectStartLocks> {
  if (!input.projectDir) {
    return {
      projectLock: await acquireProjectLock({
        runtimeRoot: input.runtimeRoot,
        projectId: input.projectId,
      }),
    };
  }

  const identity = await resolveProjectIdentityLock({
    projectDir: input.projectDir,
  });
  const identityLock = await acquireProjectLock({
    runtimeRoot: identity.runtimeRoot,
    projectId: identity.projectId,
    cwd: identity.canonicalProjectDir,
  });

  try {
    const projectLock = await acquireProjectLock({
      runtimeRoot: input.runtimeRoot,
      projectId: input.projectId,
    });
    return { projectLock, identityLock };
  } catch (error) {
    await releaseProjectLock(identityLock);
    throw error;
  }
}

export async function releaseProjectStartLocks(
  locks: ProjectStartLocks | null | undefined
): Promise<void> {
  if (!locks) {
    return;
  }
  try {
    await releaseProjectLock(locks.projectLock);
  } finally {
    await releaseProjectLock(locks.identityLock);
  }
}
