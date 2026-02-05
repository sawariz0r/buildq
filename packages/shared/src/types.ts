export type JobStatus = 'queued' | 'claimed' | 'building' | 'success' | 'error' | 'cancelled';
export type Platform = 'ios' | 'android';

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
  | { type: 'job:status'; jobId: string; status: JobStatus; error?: string; exitCode?: number }
  | { type: 'job:log'; jobId: string; stream: 'stdout' | 'stderr'; data: string }
  | { type: 'job:artifact'; jobId: string; filename: string };

export const VALID_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  queued: ['claimed', 'cancelled'],
  claimed: ['building', 'cancelled', 'error'],
  building: ['success', 'error', 'cancelled'],
  success: [],
  error: [],
  cancelled: [],
};
