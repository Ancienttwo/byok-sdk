import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  contentHash,
  createMutableClock,
  isCoreError,
  tenantId,
  type StorageReservation,
  type TenantStorageEntitlementInput,
} from '@byok-sdk/core';
import { createWebCrypto } from '@byok-sdk/cloud';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteEmbeddedStores } from '..';
import { isSqliteAvailable, SqliteSchemaError } from '../../../sqlite-support';

const describeSqlite = isSqliteAvailable() ? describe : describe.skip;
const TENANT = tenantId('tenant-restart');

describeSqlite('SQLite embedded atomicity and restart', () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function databasePath(): string {
    const directory = mkdtempSync(join(tmpdir(), 'byok-sqlite-restart-'));
    directories.push(directory);
    return join(directory, 'stores.sqlite');
  }

  it('rolls back both cancellation sides when the task update fails', async () => {
    const path = databasePath();
    const clock = createMutableClock();
    const crypto = createWebCrypto();
    let composition = createSqliteEmbeddedStores({ path }, { clock, crypto });
    await composition.cloud.tasks.open(TENANT, { taskId: 'task-rollback', deviceId: 'device-1' });

    await composition.close();
    const fault = new DatabaseSync(path);
    fault.exec(`
      CREATE TRIGGER fail_cancel_update
      BEFORE UPDATE OF cancellation_requested_at ON task_attempt
      BEGIN
        SELECT RAISE(ABORT, 'injected cancellation update failure');
      END;
    `);
    fault.close();
    composition = createSqliteEmbeddedStores({ path }, { clock, crypto });

    await expect(
      composition.cloud.cancellations.request(TENANT, {
        taskId: 'task-rollback',
        proposedMessageId: 'cancel-rollback',
        materialize: async () => ({
          body: 'cancel',
          bodyHash: contentHash(`sha256:${'a'.repeat(64)}`),
          byteSize: 6n,
        }),
      }),
    ).rejects.toThrow('injected cancellation update failure');

    const rolledBack = await composition.cloud.tasks.get(TENANT, 'task-rollback');
    expect(rolledBack?.status).toBe('offered');
    expect(rolledBack).not.toHaveProperty('cancellation');
    await expect(
      composition.core.mailbox.readAfter(TENANT, { deviceId: 'device-1', afterSeq: 0 }),
    ).resolves.toMatchObject({ messages: [] });

    await composition.close();
  });

  it('fails closed on an unsupported schema version', () => {
    const path = databasePath();
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE byok_sqlite_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare("INSERT INTO byok_sqlite_meta (key, value) VALUES ('schema_version', '999')").run();
    db.close();

    const open = () => createSqliteEmbeddedStores(
      { path },
      { clock: createMutableClock(), crypto: createWebCrypto() },
    );
    expect(open).toThrow('Unsupported BYOK SQLite schema version');
    expect(open).toThrow(SqliteSchemaError);
    expect(open).toThrow(expect.objectContaining({
      code: 'SQLITE_SCHEMA_UNSUPPORTED', foundVersion: '999', requiredVersion: '6',
    }));
  });

  it('keeps the immutable target device fence across restart', async () => {
    const path = databasePath();
    const clock = createMutableClock();
    const crypto = createWebCrypto();
    const first = createSqliteEmbeddedStores({ path }, { clock, crypto });
    await first.cloud.tasks.open(TENANT, { taskId: 'task-target-fence', deviceId: 'device-target' });
    await first.close();

    const reopened = createSqliteEmbeddedStores({ path }, { clock, crypto });
    await expect(reopened.cloud.tasks.claim(TENANT, {
      taskId: 'task-target-fence',
      deviceId: 'device-intruder',
    })).resolves.toMatchObject({
      deviceId: 'device-target',
      status: 'offered',
    });
    await expect(reopened.cloud.tasks.get(TENANT, 'task-target-fence')).resolves.toMatchObject({
      deviceId: 'device-target',
      status: 'offered',
    });
    await reopened.close();
  });

  it('reopens task, cancellation delivery, object manifest, blob metadata, and bytes', async () => {
    const path = databasePath();
    const clock = createMutableClock();
    const crypto = createWebCrypto();
    const first = createSqliteEmbeddedStores({ path }, { clock, crypto });

    await first.cloud.tasks.open(TENANT, { taskId: 'task-restart', deviceId: 'device-1' });
    const cancellation = await first.cloud.cancellations.request(TENANT, {
      taskId: 'task-restart',
      proposedMessageId: 'cancel-restart',
      reason: 'restart proof',
      materialize: async (seq, messageId) => ({
        body: JSON.stringify({ v: 4, id: messageId, seq, ts: '2026-01-01T00:00:00.000Z', type: 'task.cancel', task_id: 'task-restart', payload: { reason: 'restart proof' } }),
        bodyHash: contentHash(`sha256:${'b'.repeat(64)}`),
        byteSize: 42n,
      }),
    });
    expect(cancellation?.attempt.status).toBe('cancelled');

    const bytes = new TextEncoder().encode('persistent blob');
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
    const hash = contentHash(`sha256:${[...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`);
    const reservation: StorageReservation = {
      tenantId: TENANT,
      reservationId: 'reservation-restart',
      state: 'reserved',
      kind: 'object',
      expectedBytes: BigInt(bytes.length),
      contentHash: hash,
      contentType: 'text/plain',
      createdAt: clock.now().toISOString(),
      expiresAt: new Date(clock.now().getTime() + 60_000).toISOString(),
    };
    await first.core.objects.putManifest(TENANT, {
      hash,
      byteSize: BigInt(bytes.length),
      contentType: 'text/plain',
    });
    const grant = await first.cloud.blobs.createUpload(TENANT, reservation);
    await expect(first.blobContentProxy.writeContent(grant.blobId, bytes)).resolves.toEqual({ ok: true });
    const observation = await first.cloud.blobs.observeUpload(TENANT, grant.blobId, reservation);
    expect(observation).toBeDefined();
    await first.core.objects.commit(TENANT, { hash, ...observation! });
    await first.close();

    expect(statSync(path).mode & 0o777).toBe(0o600);

    const reopened = createSqliteEmbeddedStores({ path }, { clock, crypto });
    await expect(reopened.cloud.tasks.get(TENANT, 'task-restart')).resolves.toMatchObject({
      status: 'cancelled',
      cancellation: { reason: 'restart proof' },
    });
    await expect(
      reopened.core.mailbox.readAfter(TENANT, { deviceId: 'device-1', afterSeq: 0 }),
    ).resolves.toMatchObject({ messages: [{ messageId: 'cancel-restart' }] });
    await expect(reopened.core.objects.get(TENANT, hash)).resolves.toMatchObject({ state: 'committed' });
    await expect(reopened.cloud.blobs.getDownloadUrl(TENANT, grant.blobId)).resolves.toContain(
      `/byok/blobs/${encodeURIComponent(grant.blobId)}/content`,
    );
    const content = await reopened.blobContentProxy.readContent(grant.blobId);
    expect(content?.ok).toBe(true);
    if (content?.ok) expect(content.content.data).toEqual(bytes);
    await reopened.close();
  });

  it('keeps enforcing the mailbox limit after reopen, from the durable rows (#411)', async () => {
    const path = databasePath();
    const clock = createMutableClock();
    const crypto = createWebCrypto();
    // Quota is process memory in this composition; the host re-issues its
    // entitlement on every start, exactly as the embedded server does.
    const entitlement: TenantStorageEntitlementInput = {
      version: 1n,
      hardLimitBytes: 1_000n,
      maxObjectBytes: 1_000n,
      maxInlineBytes: 1_000n,
      mailboxLimitBytes: 60n,
      retentionPolicyId: 'restart',
    };
    const row = (messageId: string, byteSize: number) => ({
      deviceId: 'device-1',
      messageId,
      admission: 'limited' as const,
      // A pending row must be a protocol envelope to survive reopen; pad it to
      // an exact byte size (`{"v":4,"p":""}` is 14 bytes).
      materialize: () => ({
        body: JSON.stringify({ v: 4, p: 'x'.repeat(byteSize - 14) }),
        bodyHash: contentHash(`sha256:${'c'.repeat(64)}`),
        byteSize: BigInt(byteSize),
      }),
    });

    const first = createSqliteEmbeddedStores({ path }, { clock, crypto });
    await first.core.quota.writeEntitlement(TENANT, entitlement);
    await first.core.mailbox.append(TENANT, row('before-restart', 40));
    await first.close();

    const reopened = createSqliteEmbeddedStores({ path }, { clock, crypto });
    await reopened.core.quota.writeEntitlement(TENANT, entitlement);
    await expect(reopened.core.mailbox.readUsage(TENANT)).resolves.toEqual({ bytes: 40n });
    const refused = await reopened.core.mailbox
      .append(TENANT, row('after-restart-over', 21))
      .then(() => undefined, (caught: unknown) => caught);
    expect(isCoreError(refused, 'storage_quota_exceeded')).toBe(true);
    await expect(
      reopened.core.mailbox.append(TENANT, row('after-restart-fits', 20)),
    ).resolves.toMatchObject({ seq: 2 });
    await expect(reopened.core.mailbox.readUsage(TENANT)).resolves.toEqual({ bytes: 60n });
    await reopened.close();
  });
});
