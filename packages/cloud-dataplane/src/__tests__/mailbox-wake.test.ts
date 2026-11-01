import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createMutableClock, contentHash, tenantId } from '@byok-sdk/core';
import { createEnvelope, encodeEnvelope } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MailboxWakeSubscription } from '@byok-sdk/cloud';
import { createPostgresMailboxWake, MailboxWakeProbeMissedError, type PostgresMailboxWake, type PostgresMailboxWakeOptions } from '../mailbox-wake';
import { createPostgresTaskEventsWake } from '../task-events-wake';
import { PostgresActivityStore } from '../stores/activity';
import { PostgresApprovalTimelineStore } from '../stores/approval-timeline';
import { createPostgresCloudMaintenance } from '../cleanup';
import { migrate } from '../migrate';
import { createPostgresCoreStores } from '../stores/core/index';
import { PostgresTaskAttemptStore } from '../stores/task-attempts';
import { PostgresTaskCancellationStore } from '../stores/task-cancellations';
import { createDataplaneScope, createObjectStorageScope, POSTGRES_URL, SKIP_DATAPLANE, type DataplaneScope } from './support/dataplane';

const DEPLOY_SQL = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const TENANT = tenantId('wake-租戶');
const DEVICE = 'device-裝置';
const clock = createMutableClock();

function body(seq: number, messageId = randomUUID()) {
  const bytes = encodeEnvelope(createEnvelope('task.offer', { instruction: 'wake', agentRef: { agentId: 'agent-wake', profileRevision: 'rev-1' }, session: { mode: 'resume', sessionRef: 'session-wake' } }, { id: messageId, taskId: 'task-wake', seq }));
  return { body: bytes, bodyHash: contentHash(`sha256:${createHash('sha256').update(bytes).digest('hex')}`), byteSize: BigInt(Buffer.byteLength(bytes)) };
}

function listenerUrl(scope: DataplaneScope): string {
  const url = new URL(POSTGRES_URL!);
  url.username = scope.role;
  url.password = scope.role;
  return url.toString();
}

const resources: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of resources.splice(0).reverse()) await dispose(); });

interface FreezableProxy {
  readonly url: string;
  /** Stops forwarding on every open connection without closing it: a half-open path. New connections forward normally. */
  freeze(): void;
}

async function freezableProxy(upstreamUrl: string): Promise<FreezableProxy> {
  const target = new URL(upstreamUrl);
  const pairs: Array<{ sockets: net.Socket[]; frozen: boolean }> = [];
  const server = net.createServer((client) => {
    const upstream = net.connect(Number(target.port), target.hostname);
    const pair = { sockets: [client, upstream], frozen: false };
    pairs.push(pair);
    for (const [from, to] of [[client, upstream], [upstream, client]] as const) {
      from.on('data', (chunk) => { if (!pair.frozen) to.write(chunk); });
      from.on('close', () => { if (!pair.frozen) to.destroy(); });
      from.on('error', () => { if (!pair.frozen) to.destroy(); });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  resources.push(async () => {
    for (const pair of pairs) for (const socket of pair.sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const url = new URL(upstreamUrl);
  url.hostname = '127.0.0.1';
  url.port = String((server.address() as net.AddressInfo).port);
  return {
    url: url.toString(),
    freeze() {
      for (const pair of pairs) {
        pair.frozen = true;
        for (const socket of pair.sockets) socket.pause();
      }
    },
  };
}

async function fixture(wakeOptions: Pick<PostgresMailboxWakeOptions, 'probeIntervalMs' | 'probeTimeoutMs'> & { readonly proxy?: boolean } = {}) {
  const { proxy: useProxy = false, ...probeOptions } = wakeOptions;
  const scope = await createDataplaneScope();
  resources.push(() => scope.dispose());
  await migrate(scope.pool, DEPLOY_SQL);
  const objectStorage = await createObjectStorageScope();
  const core = createPostgresCoreStores({ pool: scope.pool, clock, objectStorage: objectStorage.config });
  await core.quota.writeEntitlement(TENANT, {
    version: 1n, hardLimitBytes: 1_000_000n, maxObjectBytes: 1_000_000n, maxInlineBytes: 1_000_000n,
    mailboxLimitBytes: 1_000_000n, retentionPolicyId: 'wake',
  });
  const errors: Error[] = [];
  const proxy = useProxy ? await freezableProxy(listenerUrl(scope)) : undefined;
  const wake = createPostgresMailboxWake({ connectionString: proxy?.url ?? listenerUrl(scope), ...probeOptions, onError: (error) => errors.push(error) });
  resources.push(() => wake.close());
  await vi.waitFor(async () => {
    const active = await scope.pool.query("SELECT pid FROM pg_stat_activity WHERE usename = $1 AND application_name = 'byok-mailbox-wake' AND state = 'idle' AND query LIKE 'SELECT pg_notify%'", [scope.role]);
    expect(active.rowCount).toBe(1);
  });
  return { scope, core, wake, errors, proxy };
}

function subscribe(wake: PostgresMailboxWake, device = DEVICE): MailboxWakeSubscription {
  const sub = wake.subscribe(TENANT, device, new AbortController().signal);
  resources.push(async () => sub.close());
  return sub;
}

describe.skipIf(SKIP_DATAPLANE)('Postgres post-commit mailbox wake', () => {
  it('notifies only at commit and never on rollback', async () => {
    const { scope, wake } = await fixture();
    const sub = subscribe(wake);
    let notified = false;
    const waiting = sub.next(5_000).then(() => { notified = true; });
    const client = await scope.pool.connect();
    try {
      const insert = async (seq: number) => {
        const row = body(seq);
        await client.query("INSERT INTO outbox (tenant_id, device_id, seq, message_id, body, body_hash, byte_size, state, appended_at) VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', $8)", [TENANT, DEVICE, seq, randomUUID(), row.body, row.bodyHash, row.byteSize, clock.now().toISOString()]);
      };
      await client.query('BEGIN'); await insert(1);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(notified).toBe(false);
      await client.query('ROLLBACK');
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(notified).toBe(false);
      await client.query('BEGIN'); await insert(2); await client.query('COMMIT');
      await waiting;
      expect(notified).toBe(true);
      expect((await scope.pool.query('SELECT seq FROM outbox')).rows.map((r) => r.seq)).toEqual([2n]);
    } finally { client.release(); }
  });

  it('matches the SQL md5 key for non-ASCII ids and wakes for an ordinary append', async () => {
    const { scope, core, wake } = await fixture();
    const expected = createHash('md5').update(`${TENANT}\n${DEVICE}`, 'utf8').digest('hex');
    const key = await scope.pool.query('SELECT md5($1 || chr(10) || $2) AS key', [TENANT, DEVICE]);
    expect(key.rows[0].key).toBe(expected);
    const sub = subscribe(wake);
    const started = performance.now();
    const waiting = sub.next(5_000);
    await core.mailbox.append(TENANT, { deviceId: DEVICE, messageId: randomUUID(), admission: 'limited', materialize: (seq) => body(seq) });
    await waiting;
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('covers cancellation and dead-letter replay writers without facade NOTIFY', async () => {
    const { scope, core, wake } = await fixture();
    const tasks = new PostgresTaskAttemptStore(scope.pool, clock);
    const cancel = new PostgresTaskCancellationStore(scope.pool, clock);
    await tasks.open(TENANT, { taskId: 'task-wake', deviceId: DEVICE });
    const sub = subscribe(wake);
    const started = performance.now();
    const cancellation = sub.next(5_000);
    await cancel.request(TENANT, { taskId: 'task-wake', proposedMessageId: randomUUID(), materialize: (seq) => body(seq) });
    await cancellation;
    expect(performance.now() - started).toBeLessThan(1_000);
    // Replay uses an expired executable offer, not the cancellation envelope.
    const original = await core.mailbox.append(TENANT, { deviceId: DEVICE, messageId: randomUUID(), admission: 'limited', materialize: (seq) => body(seq) });
    await sub.next(100); // drain the ordinary append's hint
    await scope.pool.query("UPDATE outbox SET state = 'expired' WHERE tenant_id = $1 AND device_id = $2 AND seq = $3", [TENANT, DEVICE, original.seq]);
    const storage = await createObjectStorageScope();
    const cleanup = createPostgresCloudMaintenance({ pool: scope.pool, clock, objectStorage: storage.config });
    const replayStart = performance.now();
    const replay = sub.next(5_000);
    await cleanup.replayDeadLetter(TENANT, { deviceId: DEVICE, seq: original.seq, replayMessageId: randomUUID() });
    await replay;
    expect(performance.now() - replayStart).toBeLessThan(1_000);
  });

  it('reconnects after backend termination and wakes every local route', async () => {
    const { scope, wake, errors } = await fixture();
    const first = subscribe(wake, 'first');
    const second = subscribe(wake, 'second');
    const waits = [first.next(5_000), second.next(5_000)];
    const listener = await scope.pool.query("SELECT pid FROM pg_stat_activity WHERE usename = $1 AND application_name = 'byok-mailbox-wake'", [scope.role]);
    const started = performance.now();
    await scope.pool.query('SELECT pg_terminate_backend($1)', [listener.rows[0].pid]);
    await Promise.all(waits);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(errors.length).toBeGreaterThan(0);
    const next = first.next(5_000);
    await scope.pool.query('SELECT pg_notify($1, md5($2 || chr(10) || $3))', ['byok_mailbox_wake', TENANT, 'first']);
    await next;
  });

  it('uses one LISTEN connection for fifty concurrent subscriptions and closes them with the Host', async () => {
    const { scope, wake } = await fixture();
    const subs = Array.from({ length: 50 }, (_, i) => subscribe(wake, `device-${i}`));
    const waits = subs.map((sub) => sub.next(5_000));
    const active = await scope.pool.query("SELECT pid FROM pg_stat_activity WHERE usename = $1 AND application_name = 'byok-mailbox-wake'", [scope.role]);
    expect(active.rowCount).toBe(1);
    await wake.close(); await wake.close();
    await Promise.all(waits);
    const closed = await scope.pool.query("SELECT pid FROM pg_stat_activity WHERE usename = $1 AND application_name = 'byok-mailbox-wake'", [scope.role]);
    expect(closed.rowCount).toBe(0);
    expect(() => subscribe(wake)).toThrow('closed');
  });

  it('retires a half-open connection on a missed periodic probe and wakes again after reconnecting', async () => {
    const { scope, core, wake, errors, proxy } = await fixture({ proxy: true, probeIntervalMs: 200, probeTimeoutMs: 300 });
    const sub = subscribe(wake);
    const listenerPids = async (): Promise<number[]> => {
      const idle = await scope.pool.query("SELECT pid FROM pg_stat_activity WHERE usename = $1 AND application_name = 'byok-mailbox-wake' AND state = 'idle' AND query LIKE 'SELECT pg_notify%'", [scope.role]);
      return idle.rows.map((row) => row.pid);
    };
    const stale = await listenerPids();
    expect(stale).toHaveLength(1);
    // Stay silent past one interval so the first periodic probe is observed before the path dies.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(errors).toEqual([]);
    proxy!.freeze();
    await vi.waitFor(() => {
      expect(errors.some((error) => error instanceof MailboxWakeProbeMissedError)).toBe(true);
    }, { timeout: 2_000 });
    await vi.waitFor(async () => {
      expect((await listenerPids()).some((pid) => !stale.includes(pid))).toBe(true);
    }, { timeout: 3_000 });
    await sub.next(100); // drain the hint every route gets after a reconnect
    const started = performance.now();
    const waiting = sub.next(5_000);
    await core.mailbox.append(TENANT, { deviceId: DEVICE, messageId: randomUUID(), admission: 'limited', materialize: (seq) => body(seq) });
    await waiting;
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('mailbox wake options', () => {
  it.each([0, -1, 1.5, 2_147_483_648, Number.NaN])('rejects probeIntervalMs %s', (probeIntervalMs) => {
    expect(() => createPostgresMailboxWake({ connectionString: 'postgres://unused', probeIntervalMs })).toThrow(RangeError);
  });
});

const TRANSACTION_DSN = process.env.BYOK_TEST_MAILBOX_TRANSACTION_URL;
describe.skipIf(SKIP_DATAPLANE || TRANSACTION_DSN === undefined)('mailbox wake DSN self-check', () => {
  it('reports a missing self-NOTIFY through a real transaction-mode PgBouncer DSN', async () => {
    const errors: Error[] = [];
    const wake = createPostgresMailboxWake({ connectionString: TRANSACTION_DSN!, probeTimeoutMs: 500, onError: (error) => errors.push(error) });
    resources.push(() => wake.close());
    await vi.waitFor(() => {
      expect(errors.some((error) => error.message.includes('self-NOTIFY probe timed out'))).toBe(true);
    }, { timeout: 3_000 });
    await wake.close();
  });
});

describe.skipIf(SKIP_DATAPLANE)('Postgres task events wake (#1113 A4)', () => {
  async function taskFixture() {
    const scope = await createDataplaneScope();
    resources.push(() => scope.dispose());
    await migrate(scope.pool, DEPLOY_SQL);
    const errors: Error[] = [];
    const wake = createPostgresTaskEventsWake({ connectionString: listenerUrl(scope), onError: (error) => errors.push(error) });
    resources.push(() => wake.close());
    await vi.waitFor(async () => {
      const active = await scope.pool.query("SELECT pid FROM pg_stat_activity WHERE usename = $1 AND application_name = 'byok-task-events-wake' AND state = 'idle' AND query LIKE 'SELECT pg_notify%'", [scope.role]);
      expect(active.rowCount).toBe(1);
    });
    // The writer is another instance: its own pool and stores, sharing only the database.
    const writer = scope.openRestartPool();
    resources.push(() => writer.end());
    return {
      scope, wake, errors, writer,
      tasks: new PostgresTaskAttemptStore(writer, clock),
      activity: new PostgresActivityStore(writer, clock),
      approvals: new PostgresApprovalTimelineStore(writer, clock),
    };
  }

  it('wakes a reader on another instance at each commit to the task, and only that task', async () => {
    const { wake, tasks, activity, approvals, errors } = await taskFixture();
    const reader = new AbortController();
    resources.push(async () => reader.abort());
    const task = wake.subscribe(TENANT, 'task-wake', reader.signal);
    const otherTenant = wake.subscribe(tenantId('wake-other'), 'task-wake', reader.signal);
    const woken = async (write: () => Promise<unknown>) => {
      const started = performance.now();
      const waiting = task.next(5_000);
      await write();
      await waiting;
      expect(performance.now() - started).toBeLessThan(1_000);
    };
    await woken(() => tasks.open(TENANT, { taskId: 'task-wake', deviceId: DEVICE }));
    await woken(() => tasks.claim(TENANT, { taskId: 'task-wake', deviceId: DEVICE }));
    await woken(() => activity.append(TENANT, {
      taskId: 'task-wake', sourceEnvelopeId: 'progress', batchSeq: 1, events: [{ type: 'progress', text: 'one' }], dropped: 0, ttlMs: 600_000,
    }));
    await woken(() => approvals.append(TENANT, {
      taskId: 'task-wake', sourceEnvelopeId: 'request', event: { type: 'approval_requested', summary: 'Allow', approvalId: 'approval' },
    }));
    await woken(() => tasks.recordStatus(TENANT, { taskId: 'task-wake', status: 'complete' }));
    const started = performance.now();
    await otherTenant.next(200);
    expect(performance.now() - started).toBeGreaterThanOrEqual(190);
    expect(errors).toEqual([]);
  });

  it('notifies only at commit, with the tenant/task hash as the whole payload', async () => {
    const { scope, writer } = await taskFixture();
    const listener = new pg.Client({ connectionString: listenerUrl(scope) });
    await listener.connect();
    resources.push(() => listener.end());
    const payloads: string[] = [];
    listener.on('notification', (message) => { if (message.channel === 'byok_task_events_wake') payloads.push(message.payload ?? ''); });
    await listener.query('LISTEN byok_task_events_wake');
    const client = await writer.connect();
    try {
      const insert = (taskId: string) => client.query(
        "INSERT INTO task (tenant_id, task_id, device_id, status, updated_at) VALUES ($1, $2, $3, 'offered', $4)",
        [TENANT, taskId, DEVICE, clock.now().toISOString()],
      );
      await client.query('BEGIN'); await insert('rolled-back'); await client.query('ROLLBACK');
      await client.query('BEGIN'); await insert('committed'); await client.query('COMMIT');
    } finally { client.release(); }
    await vi.waitFor(() => expect(payloads).toHaveLength(1));
    expect(payloads).toEqual([createHash('md5').update(`${TENANT}\ncommitted`, 'utf8').digest('hex')]);
  });
});
