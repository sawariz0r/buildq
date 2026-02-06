import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Job, Runner } from '@buildq/shared';

const DEFAULT_TIMEOUT = 30_000;       // 30 seconds
const FILE_TRANSFER_TIMEOUT = 600_000; // 10 minutes

export class ApiError extends Error {
  constructor(
    public statusCode: number,
    public body: { error: string },
  ) {
    super(`API error ${statusCode}: ${body.error}`);
    this.name = 'ApiError';
  }
}

export interface ApiClient {
  submitJob(
    tarball: Buffer,
    metadata: { platform: string; profile: string; flags: string[]; submittedBy: string },
  ): Promise<{ job: Job }>;

  claimJob(
    platform: string,
    runnerId: string,
    hostname: string,
  ): Promise<{ job: Job; tarballUrl: string } | null>;

  downloadTarball(jobId: string, destPath: string): Promise<void>;

  updateJobStatus(
    jobId: string,
    status: string,
    extra?: { error?: string; exitCode?: number },
  ): Promise<{ job: Job }>;

  pushLogs(jobId: string, stream: 'stdout' | 'stderr', data: string): Promise<void>;

  pushStep(jobId: string, step: string): Promise<void>;

  uploadArtifact(jobId: string, filePath: string): Promise<void>;

  downloadArtifact(jobId: string, destPath: string): Promise<string>;

  getJob(jobId: string): Promise<Job>;

  listJobs(filters?: {
    status?: string;
    platform?: string;
    limit?: number;
  }): Promise<{
    jobs: Job[];
    stats: { queued: number; building: number; completed: number };
  }>;

  listRunners(): Promise<{ runners: Runner[] }>;

  sendHeartbeat(runnerId: string, hostname: string, platforms: string[]): Promise<void>;

  cancelJob(jobId: string): Promise<{ job: Job }>;
}

/**
 * Create an HTTP API client for the buildq server.
 *
 * All requests include `Authorization: Bearer <token>`.
 * Default timeout is 30s; file uploads/downloads use 10 minutes.
 */
export function createApiClient(config: { server: string; token: string }): ApiClient {
  // Strip trailing slash from base URL and append /api prefix
  const baseUrl = config.server.replace(/\/+$/, '') + '/api';
  const authHeader = `Bearer ${config.token}`;

  async function request(
    method: string,
    path: string,
    options: {
      body?: BodyInit;
      headers?: Record<string, string>;
      timeout?: number;
    } = {},
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const headers: Record<string, string> = {
        Authorization: authHeader,
        ...options.headers,
      };

      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: options.body,
        signal: controller.signal,
      });

      return res;
    } finally {
      clearTimeout(timer);
    }
  }

  async function jsonRequest<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    timeout?: number,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    let reqBody: BodyInit | undefined;

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      reqBody = JSON.stringify(body);
    }

    const res = await request(method, path, { body: reqBody, headers, timeout });

    if (!res.ok) {
      let errorBody: { error: string };
      try {
        errorBody = (await res.json()) as { error: string };
      } catch {
        errorBody = { error: res.statusText || `HTTP ${res.status}` };
      }
      throw new ApiError(res.status, errorBody);
    }

    const text = await res.text();
    if (!text) {
      return undefined as T;
    }
    return JSON.parse(text) as T;
  }

  return {
    async submitJob(tarball, metadata) {
      const form = new FormData();
      form.append('tarball', new Blob([tarball as unknown as ArrayBuffer]), 'project.tar.gz');
      form.append('platform', metadata.platform);
      form.append('profile', metadata.profile);
      form.append('flags', JSON.stringify(metadata.flags));
      form.append('submittedBy', metadata.submittedBy);

      const res = await request('POST', '/jobs', {
        body: form,
        timeout: FILE_TRANSFER_TIMEOUT,
      });

      if (!res.ok) {
        let errorBody: { error: string };
        try {
          errorBody = (await res.json()) as { error: string };
        } catch {
          errorBody = { error: res.statusText || `HTTP ${res.status}` };
        }
        throw new ApiError(res.status, errorBody);
      }

      return (await res.json()) as { job: Job };
    },

    async claimJob(platform, runnerId, hostname) {
      const res = await request('POST', '/jobs/claim', {
        body: JSON.stringify({ platform, runnerId, hostname }),
        headers: { 'Content-Type': 'application/json' },
      });

      if (res.status === 204) {
        return null;
      }

      if (!res.ok) {
        let errorBody: { error: string };
        try {
          errorBody = (await res.json()) as { error: string };
        } catch {
          errorBody = { error: res.statusText || `HTTP ${res.status}` };
        }
        throw new ApiError(res.status, errorBody);
      }

      return (await res.json()) as { job: Job; tarballUrl: string };
    },

    async downloadTarball(jobId, destPath) {
      const res = await request('GET', `/jobs/${jobId}/tarball`, {
        timeout: FILE_TRANSFER_TIMEOUT,
      });

      if (!res.ok) {
        let errorBody: { error: string };
        try {
          errorBody = (await res.json()) as { error: string };
        } catch {
          errorBody = { error: res.statusText || `HTTP ${res.status}` };
        }
        throw new ApiError(res.status, errorBody);
      }

      if (!res.body) {
        throw new Error('Response body is null');
      }

      const fileStream = fs.createWriteStream(destPath);
      const readable = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
      await pipeline(readable, fileStream);
    },

    async updateJobStatus(jobId, status, extra) {
      return jsonRequest<{ job: Job }>('PATCH', `/jobs/${jobId}/status`, {
        status,
        ...extra,
      });
    },

    async pushLogs(jobId, stream, data) {
      await jsonRequest<void>('POST', `/jobs/${jobId}/logs`, { stream, data });
    },

    async pushStep(jobId, step) {
      await jsonRequest<void>('POST', `/jobs/${jobId}/step`, { step });
    },

    async uploadArtifact(jobId, filePath) {
      const fileBuffer = fs.readFileSync(filePath);
      const fileName = filePath.split('/').pop() ?? 'artifact';

      const form = new FormData();
      form.append('artifact', new Blob([fileBuffer]), fileName);

      const res = await request('POST', `/jobs/${jobId}/artifact`, {
        body: form,
        timeout: FILE_TRANSFER_TIMEOUT,
      });

      if (!res.ok) {
        let errorBody: { error: string };
        try {
          errorBody = (await res.json()) as { error: string };
        } catch {
          errorBody = { error: res.statusText || `HTTP ${res.status}` };
        }
        throw new ApiError(res.status, errorBody);
      }
    },

    async downloadArtifact(jobId, destPath) {
      const res = await request('GET', `/jobs/${jobId}/artifact`, {
        timeout: FILE_TRANSFER_TIMEOUT,
      });

      if (!res.ok) {
        let errorBody: { error: string };
        try {
          errorBody = (await res.json()) as { error: string };
        } catch {
          errorBody = { error: res.statusText || `HTTP ${res.status}` };
        }
        throw new ApiError(res.status, errorBody);
      }

      // Extract filename from Content-Disposition header, fallback to default
      const contentDisposition = res.headers.get('content-disposition');
      let filename = 'artifact';
      if (contentDisposition) {
        const match = contentDisposition.match(/filename="?([^";\s]+)"?/);
        if (match?.[1]) {
          filename = match[1];
        }
      }

      if (!res.body) {
        throw new Error('Response body is null');
      }

      const fullPath = destPath.endsWith('/')
        ? `${destPath}${filename}`
        : destPath;

      const fileStream = fs.createWriteStream(fullPath);
      const readable = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
      await pipeline(readable, fileStream);

      return filename;
    },

    async getJob(jobId) {
      return jsonRequest<Job>('GET', `/jobs/${jobId}`);
    },

    async listJobs(filters) {
      const params = new URLSearchParams();
      if (filters?.status) params.set('status', filters.status);
      if (filters?.platform) params.set('platform', filters.platform);
      if (filters?.limit) params.set('limit', String(filters.limit));
      const qs = params.toString();
      const path = `/jobs${qs ? `?${qs}` : ''}`;
      return jsonRequest<{
        jobs: Job[];
        stats: { queued: number; building: number; completed: number };
      }>('GET', path);
    },

    async listRunners() {
      return jsonRequest<{ runners: Runner[] }>('GET', '/runners');
    },

    async sendHeartbeat(runnerId, hostname, platforms) {
      await jsonRequest<void>('POST', '/runners/heartbeat', {
        runnerId,
        hostname,
        platforms,
      });
    },

    async cancelJob(jobId) {
      return jsonRequest<{ job: Job }>('PATCH', `/jobs/${jobId}/status`, { status: 'cancelled' });
    },
  };
}
