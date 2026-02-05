import { Hono } from 'hono';
import type { Platform, Runner } from '@buildq/shared';

const runners = new Hono();

// In-memory runner store
const runnerMap = new Map<string, Runner>();

const ACTIVE_THRESHOLD_MS = 90_000;   // 90 seconds
const STALE_REMOVE_MS = 5 * 60_000;  // 5 minutes

// Start the stale runner cleanup interval
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

export function startRunnerCleanup(): void {
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [id, runner] of runnerMap) {
      if (now - runner.lastHeartbeat > STALE_REMOVE_MS) {
        runnerMap.delete(id);
        console.log(`[runners] Auto-removed stale runner: ${id} (${runner.hostname})`);
      }
    }
  }, 60_000);
}

export function stopRunnerCleanup(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

/**
 * Check if any active runner supports the given platform.
 */
export function hasActiveRunner(platform: Platform): boolean {
  const now = Date.now();
  for (const runner of runnerMap.values()) {
    if (
      now - runner.lastHeartbeat < ACTIVE_THRESHOLD_MS &&
      runner.platforms.includes(platform)
    ) {
      return true;
    }
  }
  return false;
}

// POST /runners/heartbeat — Register or heartbeat
runners.post('/heartbeat', async (c) => {
  const body = await c.req.json<{
    runnerId: string;
    hostname: string;
    platforms: Platform[];
  }>();

  if (!body.runnerId) {
    return c.json({ error: 'Missing runnerId' }, 400);
  }
  if (!body.platforms || !Array.isArray(body.platforms) || body.platforms.length === 0) {
    return c.json({ error: 'Missing or empty platforms array' }, 400);
  }

  const existing = runnerMap.get(body.runnerId);
  if (existing) {
    existing.lastHeartbeat = Date.now();
    existing.hostname = body.hostname;
    existing.platforms = body.platforms;
    return c.json({ runner: existing });
  }

  const runner: Runner = {
    id: body.runnerId,
    hostname: body.hostname || 'unknown',
    platforms: body.platforms,
    lastHeartbeat: Date.now(),
  };
  runnerMap.set(runner.id, runner);

  console.log(`[runners] Registered runner: ${runner.id} (${runner.hostname}) for ${runner.platforms.join(', ')}`);
  return c.json({ runner });
});

// GET /runners — List active runners
runners.get('/', (c) => {
  const now = Date.now();
  const result = Array.from(runnerMap.values()).map((runner) => ({
    ...runner,
    active: now - runner.lastHeartbeat < ACTIVE_THRESHOLD_MS,
  }));

  return c.json({ runners: result });
});

// DELETE /runners/:id — Deregister a runner
runners.delete('/:id', (c) => {
  const id = c.req.param('id');
  const existed = runnerMap.delete(id);
  if (existed) {
    console.log(`[runners] Deregistered runner: ${id}`);
  }
  return c.json({ ok: true });
});

export default runners;
