export type JobStatus = 'queued' | 'claimed' | 'building' | 'success' | 'error' | 'cancelled';
export type Platform = 'ios' | 'android';
export type RunnerStep =
  | 'downloading_tarball'
  | 'extracting'
  | 'git_init'
  | 'installing_deps'
  | 'building'
  | 'uploading_artifact';

export interface Job {
  id: string;
  status: JobStatus;
  platform: Platform;
  profile: string;
  flags: string[];
  submittedBy: string;
  claimedBy?: string;
  createdAt: number;
  updatedAt: number;
  error?: string;
  exitCode?: number;
  tarballFilename?: string;
  artifactFilename?: string;
}

export interface Runner {
  id: string;
  hostname: string;
  platforms: Platform[];
  lastHeartbeat: number;
}

export type SSEEvent =
  | { type: 'job:created'; job: Job }
  | { type: 'job:status'; jobId: string; status: JobStatus; error?: string; exitCode?: number; hostname?: string }
  | { type: 'job:log'; jobId: string; stream: 'stdout' | 'stderr'; data: string }
  | { type: 'job:artifact'; jobId: string; filename: string }
  | { type: 'job:step'; jobId: string; step: RunnerStep };

export const VALID_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  queued: ['claimed', 'cancelled'],
  claimed: ['building', 'cancelled', 'error'],
  building: ['success', 'error', 'cancelled'],
  success: [],
  error: [],
  cancelled: [],
};
