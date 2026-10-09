import {
  constants,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  type Stats,
} from "node:fs";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

function inspect(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function requirePrivate(stat: Stats, ownerUid: number, directory: boolean) {
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) {
    throw new Error(
      directory
        ? "Fleet path must be a directory"
        : "Fleet file must be a regular unlinked file"
    );
  }
  if (stat.uid !== ownerUid)
    throw new Error("Fleet persistence owner does not match service user");
  if ((stat.mode & 0o777) !== (directory ? 0o700 : 0o600)) {
    throw new Error(
      "Fleet persistence must have private permissions (0700 directory / 0600 file)"
    );
  }
}

/** Fail closed on unsafe existing paths; never chmod or take ownership of them. */
export function preparePersistence(
  dataDir: string,
  ownerUid = process.getuid?.()
): string {
  if (ownerUid === undefined)
    throw new Error("Fleet persistence requires a Unix user identity");
  if (!isAbsolute(dataDir))
    throw new Error("Fleet persistence requires an absolute directory");
  const path = resolve(dataDir);
  // Do not traverse symlinked parents. New components are private from creation.
  let current = parse(path).root;
  for (const segment of relative(current, path).split(sep).filter(Boolean)) {
    current = join(current, segment);
    let stat = inspect(current);
    if (!stat) {
      mkdirSync(current, { mode: 0o700 });
      stat = lstatSync(current);
    }
    if (!stat.isDirectory())
      throw new Error("Fleet path must be a directory without symlinks");
    if (current === path) requirePrivate(stat, ownerUid, true);
  }
  requirePrivate(lstatSync(path), ownerUid, true);
  const databasePath = join(path, "fleet.sqlite");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const stat = inspect(databasePath + suffix);
    if (stat) requirePrivate(stat, ownerUid, false);
  }
  if (!inspect(databasePath)) {
    const fd = openSync(
      databasePath,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        constants.O_NOFOLLOW,
      0o600
    );
    closeSync(fd);
  }
  return databasePath;
}
