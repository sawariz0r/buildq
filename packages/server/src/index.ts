import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { streamSSE } from 'hono/streaming';
import { nanoid } from 'nanoid';
import { authMiddleware, validateTokenStrength } from './lib/auth.js';
import * as storage from './lib/storage.js';
import * as sse from './lib/sse.js';
import { startCleanup, stopCleanup } from './lib/cleanup.js';
import jobsRouter from './routes/jobs.js';
import runnersRouter, { startRunnerCleanup, stopRunnerCleanup } from './routes/runners.js';

const app = new Hono();

// Global error handler
app.onError((err, c) => {
  console.error('[buildq] Unhandled error:', err.message);
  return c.json({ error: err.message || 'Internal server error' }, 500);
});

// Global 404 handler
app.notFound((c) => {
  return c.json({ error: 'Not found' }, 404);
});

// Health check — no auth required
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    uptime: Math.floor(process.uptime()),
  });
});

// Auth-protected API sub-app
const api = new Hono();
api.use(authMiddleware);

// Mount route groups
api.route('/jobs', jobsRouter);
api.route('/runners', runnersRouter);

// GET /api/events/:platform — SSE stream for runners to listen for new jobs
api.get('/events/:platform', async (c) => {
  const platform = c.req.param('platform');
  if (platform !== 'ios' && platform !== 'android') {
    return c.json({ error: 'Invalid platform. Must be "ios" or "android".' }, 400);
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

    sse.addClient(`platform:${platform}`, client);

    // Heartbeat every 30s
    const heartbeat = setInterval(() => {
      stream.writeSSE({ event: 'heartbeat', data: '' }).catch(() => {});
    }, 30_000);

    stream.onAbort(() => {
      clearInterval(heartbeat);
      sse.removeClient(`platform:${platform}`, clientId);
    });

    // Keep the stream open
    await new Promise(() => {});
  });
});

// Mount the API sub-app under /api
app.route('/api', api);

// Startup
async function main(): Promise<void> {
  const token = process.env['BUILDQ_TOKEN'];
  if (!token) {
    console.error('[buildq] FATAL: BUILDQ_TOKEN environment variable is not set.');
    console.error('[buildq] Set it before starting the server: BUILDQ_TOKEN=<your-token>');
    process.exit(1);
  }

  validateTokenStrength();

  await storage.init();
  startCleanup();
  startRunnerCleanup();

  const port = parseInt(process.env['PORT'] || '3000', 10);

  const server = serve({ fetch: app.fetch, port }, () => {
    console.log(`[buildq] Server listening on port ${port}`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('[buildq] Shutting down...');
    stopCleanup();
    stopRunnerCleanup();
    sse.closeAllClients();
    server.close(() => {
      console.log('[buildq] Server closed.');
      process.exit(0);
    });
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[buildq] Fatal startup error:', err);
  process.exit(1);
});
