import { EventsPollResponseSchema, MessagesSendResponseSchema, type Envelope } from '@byok/protocol';
import { AuthManager, DeviceRevokedError } from './auth-manager';
import { authedFetch } from './http-client';
import { toHttpBase } from './url';

export interface LongPollClientOptions {
  serverUrl: string;
  auth: AuthManager;
  getCursor: () => number | undefined;
  onEnvelope: (envelope: Envelope) => void;
  onCursorAdvance: (cursor: number) => void;
  /** Called once the device is found to be revoked (401 surfaced through {@link AuthManager}) — the loop stops itself rather than retrying. */
  onRevoked?: () => void;
  /** Backoff between failed poll attempts (network/HTTP errors). The reference server holds each successful request open ~50s itself (protocol §8), so this only matters when a request errors outright. Default 2s. */
  retryDelayMs?: number;
  /**
   * Minimum delay before the next request when a poll comes back with zero
   * events. The reference server holds each request open ~50s waiting for
   * something to happen, which throttles the loop for free; a server that
   * (like this SDK's own test stub) responds immediately instead would
   * otherwise make this a tight busy-loop. Default 250ms.
   */
  idleDelayMs?: number;
}

/**
 * Protocol §8 long-poll fallback: `GET /byok/events?cursor=N` in a loop,
 * used while WS connectivity is unavailable (see `ConnectionManager`), plus
 * `POST /byok/messages` for the daemon's own outbound envelopes while in
 * this mode (finding F6 — long-poll is a full transport, not receive-only:
 * see docs/protocol.md §8).
 */
export class LongPollClient {
  private running = false;
  private readonly outbox: Envelope[] = [];
  private sending = false;

  constructor(private readonly opts: LongPollClientOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
  }

  /**
   * Queue an envelope for `POST /byok/messages` (finding F6). Fire-and-forget
   * from the caller's point of view — same shape as `WsTransport.send`,
   * which also just queues and lets its own loop drain it — retried with
   * `retryDelayMs` backoff on failure until it succeeds or this client is
   * `stop()`'d or the device turns out to be revoked.
   */
  send(envelope: Envelope): void {
    this.outbox.push(envelope);
    void this.flushOutbox();
  }

  private async flushOutbox(): Promise<void> {
    if (this.sending) return; // a flush is already draining the outbox; it will pick up this push too
    this.sending = true;
    try {
      while (this.running && this.outbox.length > 0) {
        const batch = this.outbox.splice(0);
        try {
          const base = toHttpBase(this.opts.serverUrl);
          const res = await authedFetch(
            new URL('/byok/messages', base),
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ messages: batch }),
            },
            this.opts.auth,
          );
          if (!res.ok) {
            this.outbox.unshift(...batch); // retry, preserving order
            await sleep(this.opts.retryDelayMs ?? 2000);
            continue;
          }
          MessagesSendResponseSchema.parse(await res.json());
        } catch (err) {
          if (err instanceof DeviceRevokedError) {
            this.running = false;
            this.opts.onRevoked?.();
            return;
          }
          this.outbox.unshift(...batch);
          if (!this.running) return;
          await sleep(this.opts.retryDelayMs ?? 2000);
        }
      }
    } finally {
      this.sending = false;
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        const base = toHttpBase(this.opts.serverUrl);
        const url = new URL('/byok/events', base);
        const cursor = this.opts.getCursor();
        if (cursor !== undefined) url.searchParams.set('cursor', String(cursor));

        const res = await authedFetch(url, { method: 'GET' }, this.opts.auth);
        if (!res.ok) {
          await sleep(this.opts.retryDelayMs ?? 2000);
          continue;
        }

        const parsed = EventsPollResponseSchema.parse(await res.json());
        for (const envelope of parsed.events) {
          this.opts.onEnvelope(envelope as Envelope);
        }
        this.opts.onCursorAdvance(parsed.cursor);

        if (parsed.events.length === 0) {
          await sleep(this.opts.idleDelayMs ?? 250);
        }
      } catch (err) {
        if (err instanceof DeviceRevokedError) {
          this.running = false;
          this.opts.onRevoked?.();
          return;
        }
        if (!this.running) return;
        await sleep(this.opts.retryDelayMs ?? 2000);
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
