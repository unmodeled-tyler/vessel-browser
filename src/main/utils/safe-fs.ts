/**
 * safe-fs — small async wrapper around node:fs/promises.
 *
 * Goals:
 *  1. Never block the main process event loop. All operations are async.
 *  2. Make the most common patterns one-liners:
 *       - "read a file that may not exist" → readIfExists() (returns null on ENOENT)
 *       - "write to a path, create parent dir, make it private" → writeFile() (atomic)
 *       - "delete a file that may not exist" → unlink() (returns false on ENOENT)
 *       - "ensure a directory exists" → ensureDir()
 *  3. Crash-safe writes: writeFile() writes to `<path>.tmp.<rand>`, fsyncs, then
 *     renames over the destination. A crash mid-write leaves the previous good
 *     file in place rather than truncating it.
 *
 * Non-goals:
 *  - Replacing node:fs for streaming or low-level control. For those, use
 *    fs.promises directly.
 *  - Per-call retry logic. Callers decide how to recover from transient errors.
 */

import { randomBytes } from "node:crypto";
import {
  access,
  constants,
  mkdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";

/** Options for writeFile. */
export interface WriteFileOptions {
  /** When set, the file is created with this POSIX mode (e.g. 0o600 for secrets). */
  mode?: number;
  /**
   * When true, the wrapper calls chmod() after writing to ensure the file
   * ends up with the requested mode — useful because umask can strip bits
   * from the initial mode on some filesystems. Defaults to true when `mode`
   * is set.
   */
  enforceMode?: boolean;
  /**
   * When true (default), the wrapper ensures the parent directory exists by
   * recursively creating it. Set to false to require the caller to have
   * already created the directory.
   */
  ensureParentDir?: boolean;
}

/**
 * Read a file as UTF-8 string, or as Buffer if `encoding` is omitted.
 * Throws on any error other than ENOENT (use readIfExists to handle that).
 */
export async function read(
  filePath: string,
  encoding?: "utf-8",
): Promise<string>;
export async function read(filePath: string, encoding: "buffer"): Promise<Buffer>;
export async function read(
  filePath: string,
  encoding: "utf-8" | "buffer" = "utf-8",
): Promise<string | Buffer> {
  return encoding === "buffer" ? readFile(filePath) : readFile(filePath, "utf-8");
}

/**
 * Read a file that may not exist.
 *  - returns the file contents on success
 *  - returns null if the file does not exist (ENOENT)
 *  - throws on any other error
 */
export async function readIfExists(
  filePath: string,
  encoding: "utf-8" | "buffer" = "utf-8",
): Promise<string | Buffer | null> {
  try {
    return await read(filePath, encoding);
  } catch (err) {
    if (isNotFoundError(err)) return null;
    throw err;
  }
}

/**
 * Atomically write a file: write to `<path>.tmp.<rand>`, fsync, then rename
 * over the destination. By default also ensures the parent directory exists
 * and applies the requested POSIX mode.
 *
 * Returns the path of the temporary file that was renamed (mostly useful for
 * tests and logging).
 */
export async function writeFileAtomic(
  filePath: string,
  data: string | Buffer,
  options: WriteFileOptions = {},
): Promise<string> {
  const { mode, enforceMode, ensureParentDir = true } = options;

  if (ensureParentDir) {
    await ensureDir(dirname(filePath));
  }

  const tmpPath = `${filePath}.tmp.${randomBytes(6).toString("hex")}`;
  const writeOptions: { encoding?: "utf-8"; mode?: number; flag?: string } = {
    flag: "w",
  };
  if (typeof data === "string") writeOptions.encoding = "utf-8";
  if (mode != null) writeOptions.mode = mode;

  await writeFile(tmpPath, data, writeOptions);
  // Best-effort: open + fsync the temp file so its bytes are durable before
  // the rename. We use a tiny handle scope.
  const { open } = await import("node:fs/promises");
  let handle: import("node:fs/promises").FileHandle | null = null;
  try {
    handle = await open(tmpPath, "r+");
    await handle.sync();
  } catch {
    // Some filesystems don't support fsync — ignore rather than fail the write.
  } finally {
    if (handle) await handle.close();
  }
  await rename(tmpPath, filePath);

  // Defend against umask: explicitly chmod after rename.
  if (mode != null && (enforceMode ?? true)) {
    try {
      const { chmod } = await import("node:fs/promises");
      await chmod(filePath, mode);
    } catch {
      // Non-POSIX filesystems (e.g. Windows) may not support chmod.
    }
  }

  return tmpPath;
}

/** Backwards-compat alias for writeFileAtomic. */
export const writeFileSafe = writeFileAtomic;

/**
 * Delete a file. Returns true on success, false if the file did not exist.
 * Throws on any other error.
 */
export async function unlinkIfExists(filePath: string): Promise<boolean> {
  try {
    await unlink(filePath);
    return true;
  } catch (err) {
    if (isNotFoundError(err)) return false;
    throw err;
  }
}

/**
 * Ensure a directory exists, creating it (recursively) if it doesn't.
 * Pass `mode` to set the POSIX mode on newly-created directories.
 */
export async function ensureDir(
  dirPath: string,
  options: { mode?: number } = {},
): Promise<void> {
  if (options.mode != null) {
    await mkdir(dirPath, { recursive: true, mode: options.mode });
    return;
  }
  await mkdir(dirPath, { recursive: true });
}

/** Returns true if a file or directory exists at the given path. */
export async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch (err) {
    if (isNotFoundError(err)) return false;
    throw err;
  }
}

/** Best-effort recursive delete; never throws. */
export async function rmSafe(
  target: string,
  options: { force?: boolean } = {},
): Promise<void> {
  try {
    await rm(target, { recursive: true, force: options.force ?? true });
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function isNotFoundError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
