import { nanoid } from 'nanoid';
import type { Job, JobStatus, Platform } from '@buildq/shared';
import { VALID_TRANSITIONS } from '@buildq/shared';

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

const jobs = new Map<string, Job>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CreateJobParams {
  platform: Platform;
  profile: string;
  flags?: string[];
  submittedBy: string;
  tarballFilename?: string;
}

/**
 * Create a new job and insert it into the queue.
 */
export function createJob(params: CreateJobParams): Job {
  const now = Date.now();
  const job: Job = {
    id: nanoid(12),
    status: 'queued',
    platform: params.platform,
    profile: params.profile,
    flags: params.flags ?? [],
    submittedBy: params.submittedBy,
    tarballFilename: params.tarballFilename,
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(job.id, job);
  return job;
}

/**
 * Get a single job by ID, or `undefined` if it does not exist.
 */
export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

/**
 * Return every job in the queue, most-recently created first.
 */
export function getAllJobs(): Job[] {
  return Array.from(jobs.values()).sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Atomically claim the oldest queued job that matches `platform`.
 *
 * Returns the claimed job, or `undefined` when no matching job is available.
 */
export function claimNextJob(
  platform: Platform,
  runnerId: string,
  _runnerHostname: string,
): Job | undefined {
  // Find the oldest queued job whose platform matches.
  let oldest: Job | undefined;
  for (const job of jobs.values()) {
    if (job.status !== 'queued' || job.platform !== platform) continue;
    if (!oldest || job.createdAt < oldest.createdAt) {
      oldest = job;
    }
  }

  if (!oldest) return undefined;

  // Transition to 'claimed' atomically (single-threaded runtime guarantees).
  oldest.status = 'claimed';
  oldest.claimedBy = runnerId;
  oldest.updatedAt = Date.now();

  return oldest;
}

export interface UpdateExtra {
  error?: string;
  exitCode?: number;
  artifactFilename?: string;
}

/**
 * Transition a job to `newStatus`, validating against the state machine in
 * `VALID_TRANSITIONS`.  Throws if the transition is illegal or the job does
 * not exist.
 */
export function updateJobStatus(
  id: string,
  newStatus: JobStatus,
  extra?: UpdateExtra,
): Job {
  const job = jobs.get(id);
  if (!job) {
    throw new Error(`Job not found: ${id}`);
  }

  const allowed = VALID_TRANSITIONS[job.status];
  if (!allowed.includes(newStatus)) {
    throw new Error(
      `Invalid transition: ${job.status} -> ${newStatus} for job ${id}`,
    );
  }

  job.status = newStatus;
  job.updatedAt = Date.now();

  if (extra?.error !== undefined) job.error = extra.error;
  if (extra?.exitCode !== undefined) job.exitCode = extra.exitCode;
  if (extra?.artifactFilename !== undefined)
    job.artifactFilename = extra.artifactFilename;

  return job;
}

export interface QueueStats {
  total: number;
  queued: number;
  claimed: number;
  building: number;
  success: number;
  error: number;
  cancelled: number;
}

/**
 * Return a summary of how many jobs are in each status.
 */
export function getQueueStats(): QueueStats {
  const stats: QueueStats = {
    total: 0,
    queued: 0,
    claimed: 0,
    building: 0,
    success: 0,
    error: 0,
    cancelled: 0,
  };

  for (const job of jobs.values()) {
    stats.total++;
    stats[job.status]++;
  }

  return stats;
}

/**
 * Delete a job from the store. Returns `true` if the job existed.
 */
export function deleteJob(id: string): boolean {
  return jobs.delete(id);
}

/**
 * Return all jobs whose `createdAt` timestamp is older than `ageMs`
 * milliseconds ago.
 */
export function getJobsOlderThan(ageMs: number): Job[] {
  const cutoff = Date.now() - ageMs;
  const result: Job[] = [];
  for (const job of jobs.values()) {
    if (job.createdAt < cutoff) {
      result.push(job);
    }
  }
  return result;
}
