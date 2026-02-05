import { mkdir, writeFile, rm, stat, readdir } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_TARBALL_BYTES = 500 * 1024 * 1024; // 500 MB
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

// ---------------------------------------------------------------------------
// Resolved base paths (set once in init())
// ---------------------------------------------------------------------------

let storageDir: string;
let tarballsDir: string;
let artifactsDir: string;
let initialised = false;

function getStorageDir(): string {
  return process.env['STORAGE_DIR'] || '/data';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip path-traversal characters, null bytes, directory separators, and
 * collapse to a safe basename.
 */
function sanitize(input: string): string {
  // Remove null bytes.
  let clean = input.replace(/\0/g, '');
  // Remove backslashes and forward slashes.
  clean = clean.replace(/[/\\]/g, '');
  // Remove `..` sequences.
  clean = clean.replace(/\.\./g, '');
  // Take only the basename for extra safety.
  clean = basename(clean);
  // If nothing remains, use a fallback.
  if (clean.length === 0) {
    clean = 'file';
  }
  return clean;
}

/**
 * Resolve `child` under `parent` and verify the result is still inside
 * `parent`.  Throws on attempted path traversal.
 */
function safePath(parent: string, child: string): string {
  const resolved = resolve(parent, child);
  if (!resolved.startsWith(parent + '/') && resolved !== parent) {
    throw new Error('Path traversal detected');
  }
  return resolved;
}

/**
 * Write `data` (Buffer or ReadableStream) to `dest`, enforcing `maxBytes`.
 */
async function writeWithLimit(
  dest: string,
  data: Buffer | ReadableStream,
  maxBytes: number,
): Promise<void> {
  if (Buffer.isBuffer(data)) {
    if (data.length > maxBytes) {
      throw new Error(
        `Payload exceeds size limit of ${maxBytes} bytes (got ${data.length})`,
      );
    }
    await writeFile(dest, data);
    return;
  }

  // data is a ReadableStream (web stream). Convert to a Node.js Readable with
  // size enforcement.
  const nodeReadable = Readable.fromWeb(data as import('node:stream/web').ReadableStream);

  let written = 0;

  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      written += chunk.length;
      if (written > maxBytes) {
        callback(new Error(`Payload exceeds size limit of ${maxBytes} bytes`));
        return;
      }
      callback(null, chunk);
    },
  });

  const ws = createWriteStream(dest);

  try {
    await pipeline(nodeReadable, limiter, ws);
  } catch (err) {
    // Clean up partial file on failure.
    await rm(dest, { force: true }).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialise the storage directories.  Must be called once before any other
 * storage function.
 */
export async function init(): Promise<void> {
  storageDir = resolve(getStorageDir());
  tarballsDir = join(storageDir, 'tarballs');
  artifactsDir = join(storageDir, 'artifacts');

  await mkdir(tarballsDir, { recursive: true });
  await mkdir(artifactsDir, { recursive: true });

  initialised = true;
}

function ensureInit(): void {
  if (!initialised) {
    throw new Error('Storage not initialised — call init() first');
  }
}

/**
 * Save a tarball for the given job.
 */
export async function saveTarball(
  jobId: string,
  data: Buffer | ReadableStream,
): Promise<string> {
  ensureInit();
  const safeId = sanitize(jobId);
  const filename = `${safeId}.tar.gz`;
  const dest = safePath(tarballsDir, filename);
  await writeWithLimit(dest, data, MAX_TARBALL_BYTES);
  return dest;
}

/**
 * Return the absolute path to a job's tarball, or `undefined` if it does not
 * exist.
 */
export async function getTarballPath(
  jobId: string,
): Promise<string | undefined> {
  ensureInit();
  const safeId = sanitize(jobId);
  const dest = safePath(tarballsDir, `${safeId}.tar.gz`);
  try {
    await stat(dest);
    return dest;
  } catch {
    return undefined;
  }
}

/**
 * Save a build artifact for the given job.
 */
export async function saveArtifact(
  jobId: string,
  originalFilename: string,
  data: Buffer | ReadableStream,
): Promise<string> {
  ensureInit();
  const safeId = sanitize(jobId);
  const safeName = sanitize(originalFilename);
  const filename = `${safeId}-${safeName}`;
  const dest = safePath(artifactsDir, filename);
  await writeWithLimit(dest, data, MAX_ARTIFACT_BYTES);
  return dest;
}

/**
 * Return the absolute path to a job's artifact, or `undefined` if it does not
 * exist.
 */
export async function getArtifactPath(
  jobId: string,
  filename: string,
): Promise<string | undefined> {
  ensureInit();
  const safeId = sanitize(jobId);
  const safeName = sanitize(filename);
  const dest = safePath(artifactsDir, `${safeId}-${safeName}`);
  try {
    await stat(dest);
    return dest;
  } catch {
    return undefined;
  }
}

/**
 * Delete all files (tarball + artifacts) associated with a job.
 */
export async function deleteJobFiles(jobId: string): Promise<void> {
  ensureInit();
  const safeId = sanitize(jobId);

  // Remove tarball.
  const tarball = safePath(tarballsDir, `${safeId}.tar.gz`);
  await rm(tarball, { force: true });

  // Remove any artifacts whose filename starts with the job ID prefix.
  const entries = await readdir(artifactsDir);
  const prefix = `${safeId}-`;
  await Promise.all(
    entries
      .filter((name) => name.startsWith(prefix))
      .map((name) => rm(safePath(artifactsDir, name), { force: true })),
  );
}

export interface StorageStats {
  storageDir: string;
  tarballCount: number;
  artifactCount: number;
  totalTarballBytes: number;
  totalArtifactBytes: number;
}

/**
 * Return high-level stats about the files on disk.
 */
export async function getStorageStats(): Promise<StorageStats> {
  ensureInit();

  const [tarballEntries, artifactEntries] = await Promise.all([
    readdir(tarballsDir).catch(() => [] as string[]),
    readdir(artifactsDir).catch(() => [] as string[]),
  ]);

  const sumSize = async (dir: string, entries: string[]) => {
    let total = 0;
    for (const name of entries) {
      try {
        const s = await stat(join(dir, name));
        total += s.size;
      } catch {
        // file may have been removed between readdir and stat
      }
    }
    return total;
  };

  const [totalTarballBytes, totalArtifactBytes] = await Promise.all([
    sumSize(tarballsDir, tarballEntries),
    sumSize(artifactsDir, artifactEntries),
  ]);

  return {
    storageDir,
    tarballCount: tarballEntries.length,
    artifactCount: artifactEntries.length,
    totalTarballBytes,
    totalArtifactBytes,
  };
}
