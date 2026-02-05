import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CACHE_DIR = join(homedir(), '.config', 'buildq');
const CACHE_FILE = join(CACHE_DIR, '.update-check');
const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const REGISTRY_URL = 'https://registry.npmjs.org/@prpldev/buildq/latest';

interface Cache {
  latestVersion: string;
  checkedAt: number;
}

function isNewer(current: string, latest: string): boolean {
  const c = current.split('.').map(Number);
  const l = latest.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

async function readCache(): Promise<Cache | null> {
  try {
    const data = await readFile(CACHE_FILE, 'utf-8');
    return JSON.parse(data) as Cache;
  } catch {
    return null;
  }
}

async function writeCache(latestVersion: string): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  const cache: Cache = { latestVersion, checkedAt: Date.now() };
  await writeFile(CACHE_FILE, JSON.stringify(cache));
}

async function fetchLatestVersion(): Promise<string | null> {
  const res = await fetch(REGISTRY_URL, {
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { version?: string };
  return data.version ?? null;
}

export async function checkForUpdate(currentVersion: string): Promise<void> {
  try {
    let latest: string | null = null;

    const cache = await readCache();
    if (cache && Date.now() - cache.checkedAt < TTL_MS) {
      latest = cache.latestVersion;
    } else {
      latest = await fetchLatestVersion();
      if (latest) await writeCache(latest);
    }

    if (latest && isNewer(currentVersion, latest)) {
      const noColor = !!process.env['NO_COLOR'];
      const msg = noColor
        ? `There's a newer version v${latest}. Run \`npm install @prpldev/buildq -g\` to update.`
        : `\x1b[33mThere's a newer version v${latest}.\x1b[0m Run \x1b[36mnpm install @prpldev/buildq -g\x1b[0m to update.`;
      console.error(msg);
    }
  } catch {
    // Never crash the CLI for an update check
  }
}
