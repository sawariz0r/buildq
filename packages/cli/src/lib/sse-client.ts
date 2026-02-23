import EventSource from 'eventsource';
import type { SSEEvent } from '@buildq/shared';

type SSEEventHandler = (event: SSEEvent) => void;
type SSEErrorHandler = (error: Error) => void;

export type ConnectionState = 'connected' | 'reconnecting' | 'disconnected';
type StateChangeHandler = (state: ConnectionState) => void;

export interface SSEConnection {
  on(event: string, handler: SSEEventHandler): SSEConnection;
  on(event: 'error', handler: SSEErrorHandler): SSEConnection;
  on(event: 'open', handler: () => void): SSEConnection;
  on(event: 'stateChange', handler: StateChangeHandler): SSEConnection;
  close(): void;
}

const DISCONNECTED_THRESHOLD_MS = 60_000;

/** Named SSE events the server sends */
const SSE_EVENT_NAMES = ['job:status', 'job:log', 'job:artifact', 'job:created', 'job:step'] as const;

function createSSEConnection(url: string, token: string): SSEConnection {
  const es = new EventSource(url, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  const namedHandlers = new Map<string, SSEEventHandler[]>();
  const errorHandlers: SSEErrorHandler[] = [];
  const openHandlers: Array<() => void> = [];
  const stateChangeHandlers: StateChangeHandler[] = [];

  let lastConnectedAt: number = Date.now();
  let currentState: ConnectionState = 'connected';
  let stateTimer: ReturnType<typeof setInterval> | null = null;

  function emitState(state: ConnectionState) {
    if (state === currentState) return;
    currentState = state;
    for (const handler of stateChangeHandlers) {
      handler(state);
    }
  }

  // Check for disconnected state periodically
  stateTimer = setInterval(() => {
    const elapsed = Date.now() - lastConnectedAt;
    if (elapsed >= DISCONNECTED_THRESHOLD_MS && currentState !== 'disconnected') {
      emitState('disconnected');
    }
  }, 10_000);

  es.onopen = () => {
    lastConnectedAt = Date.now();
    emitState('connected');
    for (const handler of openHandlers) {
      handler();
    }
  };

  // Register listeners for each named event type the server sends
  for (const eventName of SSE_EVENT_NAMES) {
    es.addEventListener(eventName, (evt) => {
      lastConnectedAt = Date.now();
      if (currentState !== 'connected') emitState('connected');

      let parsed: SSEEvent;
      try {
        const raw = JSON.parse(evt.data ?? '');
        // Server omits the `type` discriminator — inject it from the SSE event name
        raw.type = eventName;
        parsed = raw as SSEEvent;
      } catch {
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
    if (currentState !== 'connected') emitState('connected');
  });

  es.onerror = (err) => {
    emitState('reconnecting');
    const error = new Error(err.message ?? 'SSE connection error');
    for (const handler of errorHandlers) {
      handler(error);
    }
  };

  const connection: SSEConnection = {
    on(event: string, handler: SSEEventHandler | SSEErrorHandler | (() => void) | StateChangeHandler) {
      if (event === 'error') {
        errorHandlers.push(handler as SSEErrorHandler);
      } else if (event === 'open') {
        openHandlers.push(handler as () => void);
      } else if (event === 'stateChange') {
        stateChangeHandlers.push(handler as StateChangeHandler);
      } else {
        // Named event (job:status, job:log, job:artifact, job:created, job:step, etc.)
        if (!namedHandlers.has(event)) {
          namedHandlers.set(event, []);
        }
        namedHandlers.get(event)!.push(handler as SSEEventHandler);
      }
      return connection;
    },

    close() {
      es.close();
      if (stateTimer) {
        clearInterval(stateTimer);
        stateTimer = null;
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
  const url = `${baseUrl}/api/jobs/${jobId}/events`;
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
  const url = `${baseUrl}/api/events/${platform}`;
  return createSSEConnection(url, token);
}
