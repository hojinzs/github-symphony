import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const SECURE_DIRECTORY_MODE = 0o700;

export async function writeFileAtomically(
  path: string,
  data: string | Uint8Array,
  options: { mode?: number } = {}
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: SECURE_DIRECTORY_MODE });
  await chmod(directory, SECURE_DIRECTORY_MODE);

  const temporaryPath = join(
    directory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`
  );
  let temporaryExists = false;
  try {
    const handle = await open(temporaryPath, "wx", options.mode ?? 0o600);
    temporaryExists = true;
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }

    await rename(temporaryPath, path);
    temporaryExists = false;
    await syncDirectory(directory);
  } finally {
    if (temporaryExists) {
      await rm(temporaryPath, { force: true });
    }
  }
}

export async function appendFileDurably(
  path: string,
  data: string | Uint8Array,
  options: { mode?: number } = {}
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: SECURE_DIRECTORY_MODE });
  await chmod(directory, SECURE_DIRECTORY_MODE);

  const handle = await open(path, "a", options.mode ?? 0o600);
  try {
    const buffer = typeof data === "string" ? Buffer.from(data) : data;
    await handle.write(buffer);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(directory);
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
