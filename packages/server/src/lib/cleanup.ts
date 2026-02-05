import * as queue from './queue.js';
import * as storage from './storage.js';

const DEFAULT_TTL_MS = 86_400_000; // 24 hours
const DEFAULT_INTERVAL_MS = 10 * 60_000; // 10 minutes

let intervalHandle: ReturnType<typeof setInterval> | null = null;

function getTtl(): number {
  const env = process.env['CLEANUP_TTL_MS'];
  return env ? parseInt(env, 10) : DEFAULT_TTL_MS;
}

/**
 * Run one cleanup cycle. Removes old jobs in terminal states and their files.
 * Jobs in 'building' status are skipped regardless of age.
 */
export async function runCleanupNow(): Promise<{ deletedJobs: number }> {
  const ttl = getTtl();
  const oldJobs = queue.getJobsOlderThan(ttl);
  let deletedJobs = 0;

  for (const job of oldJobs) {
    // Skip jobs that are currently building
    if (job.status === 'building' || job.status === 'claimed') {
      continue;
    }

    try {
      await storage.deleteJobFiles(job.id);
    } catch (err) {
      console.warn(`[cleanup] Failed to delete files for job ${job.id}:`, err);
    }

    queue.deleteJob(job.id);
    deletedJobs++;
  }

  if (deletedJobs > 0) {
    console.log(`[cleanup] Removed ${deletedJobs} old job(s)`);
  }

  return { deletedJobs };
}

/**
 * Start the periodic cleanup interval.
 */
export function startCleanup(intervalMs: number = DEFAULT_INTERVAL_MS): void {
  if (intervalHandle) {
    return;
  }

  intervalHandle = setInterval(() => {
    runCleanupNow().catch((err) => {
      console.error('[cleanup] Error during cleanup cycle:', err);
    });
  }, intervalMs);

  console.log(`[cleanup] Started (interval: ${intervalMs / 1000}s, TTL: ${getTtl() / 1000}s)`);
}

/**
 * Stop the periodic cleanup.
 */
export function stopCleanup(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
    console.log('[cleanup] Stopped');
  }
}
