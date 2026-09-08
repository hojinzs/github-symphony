import { realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  acquireProjectLock,
  releaseProjectLock,
  type ProjectLockHandle,
} from "@gh-symphony/orchestrator";

const PROJECT_IDENTITY_LOCK_ID = "start";
const PROJECT_IDENTITY_LOCK_FILE = ".gh-symphony-start.lock";

export type ProjectStartLocks = {
  projectLock: ProjectLockHandle;
  identityLock?: ProjectLockHandle;
};

export async function resolveProjectIdentityLock(input: {
  projectDir: string;
}): Promise<{
  runtimeRoot: string;
  projectId: string;
  canonicalProjectDir: string;
  lockPath: string;
}> {
  const canonicalProjectDir = await realpath(input.projectDir);
  return {
    runtimeRoot: canonicalProjectDir,
    projectId: PROJECT_IDENTITY_LOCK_ID,
    canonicalProjectDir,
    lockPath: join(canonicalProjectDir, PROJECT_IDENTITY_LOCK_FILE),
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
    projectLabel: identity.canonicalProjectDir,
    lockPath: identity.lockPath,
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
