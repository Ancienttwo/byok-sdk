import { createHash, randomUUID } from 'node:crypto';
import pg, { type Notification } from 'pg';
import type { TenantId } from '@byok-sdk/core';

const CONNECTION_TIMEOUT_MS = 5_000;
const DEFAULT_PROBE_INTERVAL_MS = 30_000;
// Lets the kernel notice a dead peer even when no probe is in flight.
const KEEPALIVE_INITIAL_DELAY_MS = 10_000;
const MIN_RECONNECT_MS = 100;
const MAX_RECONNECT_MS = 30_000;

/** Listener options shared by the Postgres mailbox and task events wakes. */
export interface PostgresWakeOptions {
  /** Session-mode DSN. Hyperdrive and transaction-mode poolers cannot carry LISTEN. */
  readonly connectionString: string;
  /** Bounds read latency when every hint is lost; defaults to 5 seconds. */
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

function timerMs(label: string, name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new RangeError(`${label} ${name} must be a positive timer-safe integer`);
  }
  return value;
}

/** Which notifications a listener carries, and the in-process wake it relays them to. */
export interface PostgresWakeChannel {
  readonly channel: string;
  readonly applicationName: string;
  /** Names the wake in errors and reports. */
  readonly label: string;
  readonly inner: {
    notify(tenant: TenantId, key: string): void;
    subscribe(tenant: TenantId, key: string, signal: AbortSignal): WakeSubscription;
  };
  probeMissed(message: string): Error;
}

export interface WakeSubscription {
  next(maxWaitMs: number): Promise<void>;
  close(): void;
}

export interface PostgresWake {
  subscribe(tenant: TenantId, key: string, signal: AbortSignal): WakeSubscription;
  /** Host-owned lifetime, like pool.end(). Closes all outstanding subscriptions. */
  close(): Promise<void>;
}

interface Route {
  readonly tenant: TenantId;
  readonly key: string;
  refs: number;
}

/** One resident Node listener, independent of the request pool and the authority it hints about. */
export function createPostgresWake(spec: PostgresWakeChannel, options: PostgresWakeOptions): PostgresWake {
  const { channel, label, inner } = spec;
  const probeTimeoutMs = timerMs(label, 'probeTimeoutMs', options.probeTimeoutMs ?? CONNECTION_TIMEOUT_MS);
  const probeIntervalMs = timerMs(label, 'probeIntervalMs', options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS);
  const report = options.onError ?? ((error: Error) => console.error(`[byok-sdk] Postgres ${label}`, error));
  // Routing metadata only: the subscription implementation remains in cloud.
  // Keep all colliding routes so a hash collision can only cause an extra read.
  const routes = new Map<string, Map<string, Route>>();
  const lifetime = new AbortController();
  let closePromise: Promise<void> | undefined;
  const hashFor = (tenant: TenantId, key: string): string =>
    createHash('md5').update(`${tenant}\n${key}`, 'utf8').digest('hex');
  const notify = (bucket: Map<string, Route>): void => {
    for (const route of bucket.values()) inner.notify(route.tenant, route.key);
  };

  async function listen(): Promise<void> {
    let reconnectMs = MIN_RECONNECT_MS;
    while (!lifetime.signal.aborted) {
      const client = new pg.Client({
        connectionString: options.connectionString,
        application_name: spec.applicationName,
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
        if (!lifetime.signal.aborted) failed(new Error(`${label} listener connection ended`));
      };
      const notification = (message: Notification): void => {
        if (message.channel !== channel || message.payload === undefined) return;
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
          failed(spec.probeMissed(initial
            ? `${label} self-NOTIFY probe timed out; a session-mode DSN is required`
            : `${label} connection stopped carrying notifications; periodic self-NOTIFY probe timed out`));
        }, probeTimeoutMs);
        probeTimer.unref();
        return client.query('SELECT pg_notify($1, $2)', [channel, payload]);
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
        await client.query(`LISTEN ${channel}`);
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
        failure ??= caught instanceof Error ? caught : new Error(`${label} listener failed`, { cause: caught });
      } finally {
        clearTimeout(probeTimer);
        clearInterval(probeInterval);
        lifetime.signal.removeEventListener('abort', stop);
        await end().catch((error: Error) => { failure ??= error; });
        client.removeListener('notification', notification);
      }
      if (lifetime.signal.aborted) break;
      report(failure ?? new Error(`${label} listener disconnected`));
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
    subscribe(tenant, key, signal): WakeSubscription {
      if (lifetime.signal.aborted) throw new Error(`Postgres ${label} is closed`);
      const hash = hashFor(tenant, key);
      const routeKey = JSON.stringify([tenant, key]);
      const combined = AbortSignal.any([signal, lifetime.signal]);
      const subscription = inner.subscribe(tenant, key, combined);
      if (combined.aborted) return subscription;
      let bucket = routes.get(hash);
      if (bucket === undefined) {
        bucket = new Map();
        routes.set(hash, bucket);
      }
      const route = bucket.get(routeKey) ?? { tenant, key, refs: 0 };
      route.refs += 1;
      bucket.set(routeKey, route);
      let closed = false;
      const close = (): void => {
        if (closed) return;
        closed = true;
        combined.removeEventListener('abort', close);
        subscription.close();
        route.refs -= 1;
        if (route.refs === 0) bucket.delete(routeKey);
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
