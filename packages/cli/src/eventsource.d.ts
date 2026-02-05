declare module 'eventsource' {
  interface EventSourceEvent {
    type: string;
    data?: string;
    lastEventId?: string;
    origin?: string;
    message?: string;
  }

  class EventSource {
    static readonly CONNECTING: 0;
    static readonly OPEN: 1;
    static readonly CLOSED: 2;

    readonly readyState: number;
    readonly url: string;

    onopen: ((event: EventSourceEvent) => void) | null;
    onmessage: ((event: EventSourceEvent) => void) | null;
    onerror: ((event: EventSourceEvent) => void) | null;

    constructor(url: string, eventSourceInitDict?: {
      headers?: Record<string, string>;
      proxy?: string;
      https?: Record<string, unknown>;
      withCredentials?: boolean;
      rejectUnauthorized?: boolean;
    });

    addEventListener(type: string, listener: (event: EventSourceEvent) => void): void;
    removeEventListener(type: string, listener: (event: EventSourceEvent) => void): void;
    close(): void;
  }

  export default EventSource;
}
