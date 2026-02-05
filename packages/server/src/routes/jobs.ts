import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { nanoid } from 'nanoid';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import * as queue from '../lib/queue.js';
import * as storage from '../lib/storage.js';
import * as sse from '../lib/sse.js';
import type { Platform, JobStatus } from '@buildq/shared';

const jobs = new Hono();

// POST /jobs — Submit a new build job
jobs.post('/', async (c) => {
  const body = await c.req.parseBody();

  const tarball = body['tarball'];
  const platform = body['platform'] as string | undefined;
  const profile = (body['profile'] as string) || 'development';
  const flagsRaw = body['flags'] as string | undefined;
  const submittedBy = body['submittedBy'] as string | undefined;

  if (!tarball || !(tarball instanceof File)) {
    return c.json({ error: 'Missing required field: tarball' }, 400);
  }
  if (!platform || (platform !== 'ios' && platform !== 'android')) {
    return c.json({ error: 'Invalid or missing platform. Must be "ios" or "android".' }, 400);
  }
  if (!submittedBy) {
    return c.json({ error: 'Missing required field: submittedBy' }, 400);
  }

  let flags: string[] = [];
  if (flagsRaw) {
    try {
      flags = JSON.parse(flagsRaw);
      if (!Array.isArray(flags)) throw new Error('not an array');
    } catch {
      return c.json({ error: 'flags must be a JSON array' }, 400);
    }
  }

  const job = queue.createJob({
    platform: platform as Platform,
    profile,
    flags,
    submittedBy,
  });

  try {
    await storage.saveTarball(job.id, Buffer.from(await tarball.arrayBuffer()));
    job.tarballFilename = `${job.id}.tar.gz`;
  } catch (err) {
    queue.deleteJob(job.id);
    return c.json({ error: `Failed to save tarball: ${(err as Error).message}` }, 400);
  }

  sse.broadcastToPlatform(platform as Platform, 'job:created', { job });

  return c.json({ job }, 201);
});

// GET /jobs — List all jobs
jobs.get('/', (c) => {
  const statusFilter = c.req.query('status') as JobStatus | undefined;
  const platformFilter = c.req.query('platform') as Platform | undefined;
  const limit = parseInt(c.req.query('limit') || '50', 10);

  let allJobs = queue.getAllJobs();

  if (statusFilter) {
    allJobs = allJobs.filter((j) => j.status === statusFilter);
  }
  if (platformFilter) {
    allJobs = allJobs.filter((j) => j.platform === platformFilter);
  }

  const limited = allJobs.slice(0, limit);
  const stats = queue.getQueueStats();

  return c.json({
    jobs: limited,
    stats: {
      queued: stats.queued,
      building: stats.building,
      completed: stats.success + stats.error + stats.cancelled,
    },
  });
});

// GET /jobs/:id — Get job details
jobs.get('/:id', (c) => {
  const job = queue.getJob(c.req.param('id'));
  if (!job) {
    return c.json({ error: 'Job not found' }, 404);
  }
  return c.json(job);
});

// POST /jobs/claim — Runner claims next job
jobs.post('/claim', async (c) => {
  const body = await c.req.json<{
    platform: string;
    runnerId: string;
    hostname: string;
  }>();

  if (!body.platform || (body.platform !== 'ios' && body.platform !== 'android')) {
    return c.json({ error: 'Invalid or missing platform' }, 400);
  }
  if (!body.runnerId) {
    return c.json({ error: 'Missing runnerId' }, 400);
  }

  const job = queue.claimNextJob(
    body.platform as Platform,
    body.runnerId,
    body.hostname || 'unknown',
  );

  if (!job) {
    return c.body(null, 204);
  }

  sse.broadcastToJob(job.id, 'job:status', {
    jobId: job.id,
    status: 'claimed',
  });

  return c.json({
    job,
    tarballUrl: `/jobs/${job.id}/tarball`,
  });
});

// GET /jobs/:id/tarball — Download source tarball
jobs.get('/:id/tarball', async (c) => {
  const job = queue.getJob(c.req.param('id'));
  if (!job) {
    return c.json({ error: 'Job not found' }, 404);
  }
  if (job.status !== 'claimed' && job.status !== 'building') {
    return c.json({ error: `Cannot download tarball for job in '${job.status}' status` }, 400);
  }

  const tarballPath = await storage.getTarballPath(job.id);
  if (!tarballPath) {
    return c.json({ error: 'Tarball not found' }, 404);
  }

  const stream = createReadStream(tarballPath);
  c.header('Content-Type', 'application/gzip');
  c.header('Content-Disposition', `attachment; filename="${job.id}.tar.gz"`);
  return c.body(Readable.toWeb(stream) as ReadableStream);
});

// PATCH /jobs/:id/status — Update job status
jobs.patch('/:id/status', async (c) => {
  const jobId = c.req.param('id');
  const body = await c.req.json<{
    status: JobStatus;
    error?: string;
    exitCode?: number;
  }>();

  if (!body.status) {
    return c.json({ error: 'Missing status' }, 400);
  }

  try {
    const job = queue.updateJobStatus(jobId, body.status, {
      error: body.error,
      exitCode: body.exitCode,
    });

    sse.broadcastToJob(jobId, 'job:status', {
      jobId,
      status: body.status,
      error: body.error,
      exitCode: body.exitCode,
    });

    return c.json({ job });
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes('not found')) {
      return c.json({ error: message }, 404);
    }
    return c.json({ error: message }, 409);
  }
});

// POST /jobs/:id/logs — Push log lines
jobs.post('/:id/logs', async (c) => {
  const jobId = c.req.param('id');
  const job = queue.getJob(jobId);

  if (!job) {
    return c.json({ error: 'Job not found' }, 404);
  }
  if (job.status !== 'building') {
    return c.json({ error: `Cannot push logs for job in '${job.status}' status` }, 400);
  }

  const body = await c.req.json<{
    stream: 'stdout' | 'stderr';
    data: string;
  }>();

  sse.broadcastToJob(jobId, 'job:log', {
    jobId,
    stream: body.stream,
    data: body.data,
  });

  return c.body(null, 200);
});

// POST /jobs/:id/artifact — Upload build artifact
jobs.post('/:id/artifact', async (c) => {
  const jobId = c.req.param('id');
  const job = queue.getJob(jobId);

  if (!job) {
    return c.json({ error: 'Job not found' }, 404);
  }
  if (job.status !== 'building' && job.status !== 'success') {
    return c.json({ error: `Cannot upload artifact for job in '${job.status}' status` }, 400);
  }

  const body = await c.req.parseBody();
  const artifact = body['artifact'];

  if (!artifact || !(artifact instanceof File)) {
    return c.json({ error: 'Missing required field: artifact' }, 400);
  }

  try {
    await storage.saveArtifact(
      jobId,
      artifact.name,
      Buffer.from(await artifact.arrayBuffer()),
    );

    queue.updateJobStatus(jobId, job.status, {
      artifactFilename: artifact.name,
    });

    // Directly set artifactFilename if job is already in success state
    job.artifactFilename = artifact.name;

    sse.broadcastToJob(jobId, 'job:artifact', {
      jobId,
      filename: artifact.name,
    });

    return c.json({ filename: artifact.name });
  } catch (err) {
    return c.json({ error: `Failed to save artifact: ${(err as Error).message}` }, 400);
  }
});

// GET /jobs/:id/artifact — Download build artifact
jobs.get('/:id/artifact', async (c) => {
  const jobId = c.req.param('id');
  const job = queue.getJob(jobId);

  if (!job) {
    return c.json({ error: 'Job not found' }, 404);
  }
  if (!job.artifactFilename) {
    return c.json({ error: 'No artifact available for this job' }, 404);
  }

  const artifactPath = await storage.getArtifactPath(jobId, job.artifactFilename);
  if (!artifactPath) {
    return c.json({ error: 'Artifact file not found' }, 404);
  }

  const stream = createReadStream(artifactPath);
  c.header('Content-Type', 'application/octet-stream');
  c.header('Content-Disposition', `attachment; filename="${job.artifactFilename}"`);
  return c.body(Readable.toWeb(stream) as ReadableStream);
});

// GET /jobs/:id/events — SSE stream for a job
jobs.get('/:id/events', async (c) => {
  const jobId = c.req.param('id');
  const job = queue.getJob(jobId);

  if (!job) {
    return c.json({ error: 'Job not found' }, 404);
  }

  return streamSSE(c, async (stream) => {
    const clientId = nanoid(12);

    c.header('Cache-Control', 'no-cache');
    c.header('X-Accel-Buffering', 'no');

    const client: sse.SSEClient = {
      id: clientId,
      send(event, data) {
        stream.writeSSE({ event, data }).catch(() => {});
      },
      close() {
        stream.close().catch(() => {});
      },
    };

    sse.addClient(`job:${jobId}`, client);

    // Send current status as the first event
    await stream.writeSSE({
      event: 'job:status',
      data: JSON.stringify({
        jobId: job.id,
        status: job.status,
        error: job.error,
        exitCode: job.exitCode,
      }),
    });

    // Heartbeat every 30s
    const heartbeat = setInterval(() => {
      stream.writeSSE({ event: 'heartbeat', data: '' }).catch(() => {});
    }, 30_000);

    stream.onAbort(() => {
      clearInterval(heartbeat);
      sse.removeClient(`job:${jobId}`, clientId);
    });

    // Keep the stream open
    await new Promise(() => {});
  });
});

// POST /jobs/:id/cancel — Cancel a job (used by CLI cancel command)
jobs.post('/:id/cancel', async (c) => {
  const jobId = c.req.param('id');

  try {
    const job = queue.updateJobStatus(jobId, 'cancelled');

    sse.broadcastToJob(jobId, 'job:status', {
      jobId,
      status: 'cancelled',
    });

    return c.json({ job });
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes('not found')) {
      return c.json({ error: message }, 404);
    }
    return c.json({ error: message }, 409);
  }
});

export default jobs;
