import type { Platform } from '@buildq/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SSEClient {
  id: string;
  send: (event: string, data: string) => void;
  close: () => void;
}

// ---------------------------------------------------------------------------
// Channel map:  channel -> (clientId -> SSEClient)
// ---------------------------------------------------------------------------

const channels = new Map<string, Map<string, SSEClient>>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getOrCreateChannel(channel: string): Map<string, SSEClient> {
  let clients = channels.get(channel);
  if (!clients) {
    clients = new Map();
    channels.set(channel, clients);
  }
  return clients;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a client on a channel.
 */
export function addClient(channel: string, client: SSEClient): void {
  const clients = getOrCreateChannel(channel);
  clients.set(client.id, client);
}

/**
 * Remove a client from a channel.  If the channel becomes empty it is
 * deleted to avoid unbounded growth.
 */
export function removeClient(channel: string, clientId: string): void {
  const clients = channels.get(channel);
  if (!clients) return;
  clients.delete(clientId);
  if (clients.size === 0) {
    channels.delete(channel);
  }
}

/**
 * Broadcast an SSE message to every client on `channel`.
 *
 * `data` is JSON-serialized before sending.  Individual send failures
 * (e.g. from back-pressure or a dead connection) are caught and logged so
 * that one broken client does not prevent others from receiving the event.
 */
export function broadcast(
  channel: string,
  event: string,
  data: unknown,
): void {
  const clients = channels.get(channel);
  if (!clients) return;

  const serialized = JSON.stringify(data);

  for (const client of clients.values()) {
    try {
      client.send(event, serialized);
    } catch (err) {
      console.warn(
        `[sse] Failed to send event "${event}" to client ${client.id} on channel "${channel}":`,
        err,
      );
    }
  }
}

/**
 * Broadcast to the channel dedicated to a specific job (`job:<jobId>`).
 */
export function broadcastToJob(
  jobId: string,
  event: string,
  data: unknown,
): void {
  broadcast(`job:${jobId}`, event, data);
}

/**
 * Broadcast to the channel dedicated to a platform (`platform:<platform>`).
 */
export function broadcastToPlatform(
  platform: Platform,
  event: string,
  data: unknown,
): void {
  broadcast(`platform:${platform}`, event, data);
}

/**
 * Return the total number of connected clients across all channels.
 */
export function getConnectedClients(): number {
  let total = 0;
  for (const clients of channels.values()) {
    total += clients.size;
  }
  return total;
}

/**
 * Close every client on every channel and clear the channel map.
 */
export function closeAllClients(): void {
  for (const clients of channels.values()) {
    for (const client of clients.values()) {
      try {
        client.close();
      } catch {
        // ignore errors during shutdown
      }
    }
  }
  channels.clear();
}
