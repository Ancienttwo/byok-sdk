import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  contentHash,
  createMutableClock,
  tenantId,
  type StorageReservation,
} from '@byok-sdk/core';
import { createWebCrypto } from '@byok-sdk/cloud';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteEmbeddedStores } from '..';
import { isSqliteAvailable, openSqliteDatabase } from '../../../sqlite-support';

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
    const composition = createSqliteEmbeddedStores({ path }, { clock, crypto: createWebCrypto() });
    await composition.cloud.tasks.open(TENANT, { taskId: 'task-rollback', deviceId: 'device-1' });

    const fault = openSqliteDatabase(path);
    fault.exec(`
      CREATE TRIGGER fail_cancel_update
      BEFORE UPDATE OF cancellation_requested_at ON task_attempt
      BEGIN
        SELECT RAISE(ABORT, 'injected cancellation update failure');
      END;
    `);
    fault.close();

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
    const db = openSqliteDatabase(path);
    db.exec('CREATE TABLE byok_sqlite_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare("INSERT INTO byok_sqlite_meta (key, value) VALUES ('schema_version', '999')").run();
    db.close();

    expect(() =>
      createSqliteEmbeddedStores(
        { path },
        { clock: createMutableClock(), crypto: createWebCrypto() },
      ),
    ).toThrow('Unsupported BYOK SQLite schema version');
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
        body: JSON.stringify({ seq, messageId }),
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
});
