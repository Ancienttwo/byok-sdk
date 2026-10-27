import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createMutableClock, contentHash, tenantId } from '@byok-sdk/core';
import { createEnvelope, encodeEnvelope } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MailboxWakeSubscription } from '@byok-sdk/cloud';
import { createPostgresMailboxWake, type PostgresMailboxWake } from '../mailbox-wake';
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
  const bytes = encodeEnvelope(createEnvelope('task.offer_for_agent', { instruction: 'wake', agentRef: { agentId: 'agent-wake', profileRevision: 'rev-1' } }, { id: messageId, taskId: 'task-wake', seq }));
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

async function fixture() {
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
  const wake = createPostgresMailboxWake({ connectionString: listenerUrl(scope), onError: (error) => errors.push(error) });
  resources.push(() => wake.close());
  await vi.waitFor(async () => {
    const active = await scope.pool.query("SELECT pid FROM pg_stat_activity WHERE usename = $1 AND application_name = 'byok-mailbox-wake' AND state = 'idle' AND query LIKE 'SELECT pg_notify%'", [scope.role]);
    expect(active.rowCount).toBe(1);
  });
  return { scope, core, wake, errors };
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
