import EventSource from 'eventsource';
import type { SSEEvent } from '@buildq/shared';

type SSEEventHandler = (event: SSEEvent) => void;
type SSEErrorHandler = (error: Error) => void;

export interface SSEConnection {
  on(event: string, handler: SSEEventHandler): SSEConnection;
  on(event: 'error', handler: SSEErrorHandler): SSEConnection;
  on(event: 'open', handler: () => void): SSEConnection;
  close(): void;
}

const UNREACHABLE_WARNING_MS = 60_000;

/** Named SSE events the server sends */
const SSE_EVENT_NAMES = ['job:status', 'job:log', 'job:artifact', 'job:created'] as const;

function createSSEConnection(url: string, token: string): SSEConnection {
  const es = new EventSource(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const namedHandlers = new Map<string, SSEEventHandler[]>();
  const errorHandlers: SSEErrorHandler[] = [];
  const openHandlers: Array<() => void> = [];

  let lastConnectedAt: number = Date.now();
  let unreachableWarned = false;
  let unreachableTimer: ReturnType<typeof setInterval> | null = null;

  // Track connection state for 60s unreachable warning
  unreachableTimer = setInterval(() => {
    const elapsed = Date.now() - lastConnectedAt;
    if (elapsed >= UNREACHABLE_WARNING_MS && !unreachableWarned) {
      unreachableWarned = true;
      console.warn(
        `[buildq] SSE connection has been unreachable for ${Math.round(elapsed / 1000)}s`,
      );
    }
  }, 10_000);

  es.onopen = () => {
    lastConnectedAt = Date.now();
    unreachableWarned = false;
    for (const handler of openHandlers) {
      handler();
    }
  };

  // Register listeners for each named event type the server sends
  for (const eventName of SSE_EVENT_NAMES) {
    es.addEventListener(eventName, (evt) => {
      lastConnectedAt = Date.now();
      unreachableWarned = false;

      let parsed: SSEEvent;
      try {
        parsed = JSON.parse(evt.data ?? '') as SSEEvent;
      } catch {
        console.warn(`[buildq] Failed to parse SSE event data for "${eventName}", skipping:`, evt.data);
        return;
      }

      const handlers = namedHandlers.get(eventName);
      if (handlers) {
        for (const handler of handlers) {
          handler(parsed);
        }
      }
    });
  }

  // Heartbeat events reset the connection tracker without parsing data
  es.addEventListener('heartbeat', () => {
    lastConnectedAt = Date.now();
    unreachableWarned = false;
  });

  es.onerror = (err) => {
    const error = new Error(err.message ?? 'SSE connection error');
    for (const handler of errorHandlers) {
      handler(error);
    }
  };

  const connection: SSEConnection = {
    on(event: string, handler: SSEEventHandler | SSEErrorHandler | (() => void)) {
      if (event === 'error') {
        errorHandlers.push(handler as SSEErrorHandler);
      } else if (event === 'open') {
        openHandlers.push(handler as () => void);
      } else {
        // Named event (job:status, job:log, job:artifact, job:created, etc.)
        if (!namedHandlers.has(event)) {
          namedHandlers.set(event, []);
        }
        namedHandlers.get(event)!.push(handler as SSEEventHandler);
      }
      return connection;
    },

    close() {
      es.close();
      if (unreachableTimer) {
        clearInterval(unreachableTimer);
        unreachableTimer = null;
      }
    },
  };

  return connection;
}

/**
 * Connect to the SSE stream for a specific job.
 * Receives events related to the given job (status changes, logs, artifacts).
 */
export function connectToJob(serverUrl: string, token: string, jobId: string): SSEConnection {
  const baseUrl = serverUrl.replace(/\/+$/, '');
  const url = `${baseUrl}/jobs/${jobId}/events`;
  return createSSEConnection(url, token);
}

/**
 * Connect to the SSE stream for a platform.
 * Receives events for all jobs on the given platform (useful for runners).
 */
export function connectToPlatform(
  serverUrl: string,
  token: string,
  platform: string,
): SSEConnection {
  const baseUrl = serverUrl.replace(/\/+$/, '');
  const url = `${baseUrl}/events?platform=${platform}`;
  return createSSEConnection(url, token);
}
