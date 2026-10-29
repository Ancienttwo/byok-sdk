import { createHash, randomUUID } from 'node:crypto';
import pg, { type Notification } from 'pg';
import {
  createInProcessMailboxWake,
  type MailboxWake,
  type MailboxWakeSubscription,
} from '@byok-sdk/cloud';
import type { TenantId } from '@byok-sdk/core';

const CHANNEL = 'byok_mailbox_wake';
const APPLICATION_NAME = 'byok-mailbox-wake';
const CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_PROBE_INTERVAL_MS = 30_000;
// Lets the kernel notice a dead peer even when no probe is in flight.
const KEEPALIVE_INITIAL_DELAY_MS = 10_000;
const MIN_RECONNECT_MS = 100;
const MAX_RECONNECT_MS = 30_000;

export interface PostgresMailboxWakeOptions {
  /** Session-mode DSN. Hyperdrive and transaction-mode poolers cannot carry LISTEN. */
  readonly connectionString: string;
  readonly fallbackMs?: number;
  /** Missing probe or connection failure; default reports to console.error. Must not throw. */
  readonly onError?: (error: Error) => void;
  /**
   * Self-NOTIFY observation deadline for the connect probe and every periodic
   * probe; defaults to 5 seconds. A miss retires the connection.
   */
  readonly probeTimeoutMs?: number;
  /**
   * Period of the self-NOTIFY probe on an established connection; defaults to
   * 30 seconds. It detects a half-open path (an idle NAT or load balancer
   * dropping the flow without closing it), which otherwise stops notifications
   * silently.
   */
  readonly probeIntervalMs?: number;
}

/** A self-NOTIFY probe was not observed, so the connection cannot be trusted to carry notifications. */
export class MailboxWakeProbeMissedError extends Error {
  override readonly name = 'MailboxWakeProbeMissedError';
}

function timerMs(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new RangeError(`mailbox wake ${name} must be a positive timer-safe integer`);
  }
  return value;
}

export interface PostgresMailboxWake extends MailboxWake {
  /** Host-owned lifetime, like pool.end(). Closes all outstanding subscriptions. */
  close(): Promise<void>;
}

interface Route {
  readonly tenant: TenantId;
  readonly deviceId: string;
  refs: number;
}

/** One resident Node listener, independent of the request pool and the mailbox authority. */
export function createPostgresMailboxWake(options: PostgresMailboxWakeOptions): PostgresMailboxWake {
  const inner = createInProcessMailboxWake({
    ...(options.fallbackMs === undefined ? {} : { fallbackMs: options.fallbackMs }),
  });
  const probeTimeoutMs = timerMs('probeTimeoutMs', options.probeTimeoutMs ?? CONNECTION_TIMEOUT_MS);
  const probeIntervalMs = timerMs('probeIntervalMs', options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS);
  const report = options.onError ?? ((error: Error) => console.error('[byok-sdk] Postgres mailbox wake', error));
  // Routing metadata only: the subscription implementation remains in cloud.
  // Keep all colliding routes so a hash collision can only cause an extra read.
  const routes = new Map<string, Map<string, Route>>();
  const lifetime = new AbortController();
  let closePromise: Promise<void> | undefined;
  const hashFor = (tenant: TenantId, deviceId: string): string =>
    createHash('md5').update(`${tenant}\n${deviceId}`, 'utf8').digest('hex');
  const notify = (bucket: Map<string, Route>): void => {
    for (const route of bucket.values()) inner.appended(route.tenant, route.deviceId);
  };

  async function listen(): Promise<void> {
    let reconnectMs = MIN_RECONNECT_MS;
    while (!lifetime.signal.aborted) {
      const client = new pg.Client({
        connectionString: options.connectionString,
        application_name: APPLICATION_NAME,
        connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
        query_timeout: CONNECTION_TIMEOUT_MS,
        keepAlive: true,
        keepAliveInitialDelayMillis: KEEPALIVE_INITIAL_DELAY_MS,
      });
      const disconnected = new AbortController();
      // At most one probe is outstanding; an earlier payload cannot satisfy a later one.
      let outstanding: string | undefined;
      let probeTimer: ReturnType<typeof setTimeout> | undefined;
      let probeInterval: ReturnType<typeof setInterval> | undefined;
      let failure: Error | undefined;
      const failed = (error: Error): void => {
        failure ??= error;
        disconnected.abort();
      };
      const ended = (): void => {
        if (!lifetime.signal.aborted) failed(new Error('mailbox wake listener connection ended'));
      };
      const notification = (message: Notification): void => {
        if (message.channel !== CHANNEL || message.payload === undefined) return;
        if (message.payload === outstanding) {
          clearTimeout(probeTimer);
          probeTimer = undefined;
          outstanding = undefined;
          reconnectMs = MIN_RECONNECT_MS;
          if (probeInterval === undefined) {
            probeInterval = setInterval(() => {
              if (outstanding !== undefined || disconnected.signal.aborted || lifetime.signal.aborted) return;
              sendProbe(false).catch(failed);
            }, probeIntervalMs);
            probeInterval.unref();
          }
          return;
        }
        const bucket = routes.get(message.payload);
        if (bucket !== undefined) notify(bucket);
      };
      const sendProbe = (initial: boolean): Promise<unknown> => {
        const payload = `probe:${randomUUID()}`;
        outstanding = payload;
        probeTimer = setTimeout(() => {
          probeTimer = undefined;
          // This connection cannot prove it carries notifications. Retire it,
          // report once, and retry with backoff; reads still use fallbackMs.
          failed(new MailboxWakeProbeMissedError(initial
            ? 'mailbox wake self-NOTIFY probe timed out; a session-mode DSN is required'
            : 'mailbox wake connection stopped carrying notifications; periodic self-NOTIFY probe timed out'));
        }, probeTimeoutMs);
        probeTimer.unref();
        return client.query('SELECT pg_notify($1, $2)', [CHANNEL, payload]);
      };
      client.on('error', failed);
      client.on('end', ended);
      client.on('notification', notification);
      let ending: Promise<void> | undefined;
      const end = (): Promise<void> => ending ??= client.end();
      const stop = (): void => { void end().catch(failed); };
      lifetime.signal.addEventListener('abort', stop, { once: true });
      try {
        await client.connect();
        if (lifetime.signal.aborted) break;
        await client.query(`LISTEN ${CHANNEL}`);
        // A reconnected listener missed hints, so every local route must read.
        for (const bucket of routes.values()) notify(bucket);
        await sendProbe(true);
        if (!lifetime.signal.aborted && !disconnected.signal.aborted) {
          await new Promise<void>((resolve) => {
            const finish = (): void => {
              lifetime.signal.removeEventListener('abort', finish);
              disconnected.signal.removeEventListener('abort', finish);
              resolve();
            };
            lifetime.signal.addEventListener('abort', finish, { once: true });
            disconnected.signal.addEventListener('abort', finish, { once: true });
          });
        }
      } catch (caught) {
        failure ??= caught instanceof Error ? caught : new Error('mailbox wake listener failed', { cause: caught });
      } finally {
        clearTimeout(probeTimer);
        clearInterval(probeInterval);
        lifetime.signal.removeEventListener('abort', stop);
        await end().catch((error: Error) => { failure ??= error; });
        client.removeListener('notification', notification);
      }
      if (lifetime.signal.aborted) break;
      report(failure ?? new Error('mailbox wake listener disconnected'));
      if (lifetime.signal.aborted) break;
      await new Promise<void>((resolve) => {
        const finish = (): void => {
          clearTimeout(timer);
          lifetime.signal.removeEventListener('abort', finish);
          resolve();
        };
        const timer = setTimeout(finish, reconnectMs);
        lifetime.signal.addEventListener('abort', finish, { once: true });
      });
      reconnectMs = Math.min(MAX_RECONNECT_MS, reconnectMs * 2);
    }
  }

  const running = listen();
  return {
    // Only the transaction trigger signals Postgres commits, including writers
    // in other processes and maintenance replay. No application-layer NOTIFY.
    appended() {},
    subscribe(tenant, deviceId, signal): MailboxWakeSubscription {
      if (lifetime.signal.aborted) throw new Error('Postgres mailbox wake is closed');
      const hash = hashFor(tenant, deviceId);
      const key = JSON.stringify([tenant, deviceId]);
      const combined = AbortSignal.any([signal, lifetime.signal]);
      const subscription = inner.subscribe(tenant, deviceId, combined);
      if (combined.aborted) return subscription;
      let bucket = routes.get(hash);
      if (bucket === undefined) {
        bucket = new Map();
        routes.set(hash, bucket);
      }
      const route = bucket.get(key) ?? { tenant, deviceId, refs: 0 };
      route.refs += 1;
      bucket.set(key, route);
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        combined.removeEventListener('abort', close);
        subscription.close();
        route.refs -= 1;
        if (route.refs === 0) bucket.delete(key);
        if (bucket.size === 0) routes.delete(hash);
      };
      combined.addEventListener('abort', close, { once: true });
      return { next: (maxWaitMs) => subscription.next(maxWaitMs), close };
    },
    close() {
      closePromise ??= (async () => {
        lifetime.abort();
        await running;
      })();
      return closePromise;
    },
  };
}
