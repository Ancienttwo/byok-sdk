import type { BodyInit } from 'undici';
import { describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { contentHash, createMutableClock, tenantId } from '@byok-sdk/core';
import { createWebCrypto } from '@byok-sdk/cloud';
import { createPostgresCoreStores } from '../stores/core';
import { PostgresObjectStore } from '../stores/core/objects';
import { R2CloudBlobStore, R2ObjectMaintenanceStore, type ObjectStoreFetch } from '../stores/r2-blobs';
import { migrate } from '../migrate';
import { createDataplaneScope, createObjectStorageScope, SKIP_DATAPLANE } from './support/dataplane';
const deploySql = fileURLToPath(new URL('../../../../deploy/sql', import.meta.url));
const tenant = tenantId('physical-object-retention');
async function setup(fetchOverride?: ObjectStoreFetch) {
  const scope = await createDataplaneScope(8);
  try {
    await migrate(scope.pool, deploySql);
    const clock = createMutableClock();
    const objectStorage = await createObjectStorageScope();
    const core = createPostgresCoreStores({ pool: scope.pool, clock, objectStorage: objectStorage.config });
    const bytes = new TextEncoder().encode('physical retention bytes');
    const hash = contentHash(await createWebCrypto().sha256(bytes));
    const size = BigInt(bytes.length);
    await core.quota.writeEntitlement(tenant, { version: 1n, hardLimitBytes: 1000n, maxObjectBytes: 100n, maxInlineBytes: 100n, mailboxLimitBytes: 100n, retentionPolicyId: 'test' });
    const blobs = new R2CloudBlobStore({ ...objectStorage.config, objects: core.objects });
    async function upload(reservationId: string) {
      const reservation = await core.quota.reserve(tenant, { reservationId, kind: 'object', expectedBytes: size, contentHash: hash, contentType: 'text/plain', ttlMs: 60_000 });
      const grant = await blobs.createUpload(tenant, reservation);
      const response = await fetch(grant.uploadUrl, { method: 'PUT', headers: { 'content-type': 'text/plain', 'content-length': String(bytes.length) }, body: bytes as unknown as BodyInit });
      expect(response.ok).toBe(true);
      const observed = await blobs.observeUpload(tenant, grant.blobId, reservation);
      expect(observed).toEqual({ observedByteSize: size, observedContentType: 'text/plain' });
      await core.quota.finalizeReservation(tenant, { reservationId, ...observed! });
    }
    await upload('first');
    clock.advance(2000);
    const storage = new R2ObjectMaintenanceStore({ ...objectStorage.config, maxAttempts: 1, ...(fetchOverride === undefined ? {} : { fetch: fetchOverride }) });
    const collector = new PostgresObjectStore(scope.pool, clock, storage);
    return { scope, core, clock, storage, collector, hash, size, upload, bounds: { now: clock.now().toISOString(), orphanBefore: new Date(clock.now().getTime() - 1000).toISOString(), limit: 1 } };
  } catch (cause) { await scope.dispose(); throw cause; }
}
async function until(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Expected real PostgreSQL lock wait did not occur.');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
describe.skipIf(SKIP_DATAPLANE)('PG and independent S3 physical object retention', () => {
  it('reports a failed per-object connection without losing the tombstone or charge', async () => {
    const composition = await setup();
    const query = composition.scope.pool.query;
    const connect = composition.scope.pool.connect;
    let selected = false;
    const selection = vi.spyOn(composition.scope.pool, 'query').mockImplementation((...args: unknown[]) => {
      const result = Reflect.apply(query, composition.scope.pool, args);
      if (typeof args[0] === 'string' && args[0].startsWith('INSERT INTO gc_cursor')) {
        return Promise.resolve(result).then(value => { selected = true; return value; });
      }
      return result;
    });
    const connection = vi.spyOn(composition.scope.pool, 'connect').mockImplementation((...args: unknown[]) => {
      if (selected) { selected = false; return Promise.reject(new Error('injected object connection failure')); }
      return Reflect.apply(connect, composition.scope.pool, args);
    });
    try {
      await expect(composition.collector.collectExpired(tenant, composition.bounds)).rejects.toMatchObject({
        failedRows: 1, committed: { removed: 0, expired: 0, releasedBytes: 0n }, more: true,
      });
      selection.mockRestore(); connection.mockRestore();
      expect(await composition.core.objects.get(tenant, composition.hash)).toMatchObject({ state: 'delete_pending' });
      expect(await composition.storage.inspectObject(tenant, composition.hash)).toBeDefined();
      expect(await composition.core.quota.readUsage(tenant)).toMatchObject({ committedObjectBytes: composition.size });
      expect(await composition.collector.collectExpired(tenant, composition.bounds)).toEqual({ removed: 1, expired: 0, releasedBytes: composition.size, more: false });
    } finally { selection.mockRestore(); connection.mockRestore(); await composition.scope.dispose(); }
  });

  it('fails before deleting bytes when persisting the selected cursor fails', async () => {
    const composition = await setup();
    const query = composition.scope.pool.query;
    const hook = vi.spyOn(composition.scope.pool, 'query').mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].startsWith('INSERT INTO gc_cursor')) {
        return Promise.reject(new Error('injected cursor write failure'));
      }
      return Reflect.apply(query, composition.scope.pool, args);
    });
    try {
      await expect(composition.collector.collectExpired(tenant, composition.bounds)).rejects.toThrow('injected cursor write failure');
      hook.mockRestore();
      expect(await composition.storage.inspectObject(tenant, composition.hash)).toBeDefined();
      expect(await composition.core.objects.get(tenant, composition.hash)).toMatchObject({ state: 'delete_pending' });
      expect(await composition.core.quota.readUsage(tenant)).toMatchObject({ committedObjectBytes: composition.size });
      expect(await composition.collector.collectExpired(tenant, composition.bounds)).toEqual({ removed: 1, expired: 0, releasedBytes: composition.size, more: false });
    } finally { hook.mockRestore(); await composition.scope.dispose(); }
  });

  it('preserves committed deletion counts when the final remainder query fails', async () => {
    const composition = await setup();
    const query = composition.scope.pool.query;
    const hook = vi.spyOn(composition.scope.pool, 'query').mockImplementation((...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].startsWith('SELECT 1 FROM object_manifest m WHERE')) {
        return Promise.reject(new Error('injected remainder query failure'));
      }
      return Reflect.apply(query, composition.scope.pool, args);
    });
    try {
      const failure = await composition.collector.collectExpired(tenant, composition.bounds).then(
        () => { throw new Error('Expected the remainder probe to fail.'); }, error => error,
      );
      hook.mockRestore();
      expect(await composition.core.objects.get(tenant, composition.hash)).toMatchObject({ state: 'deleted' });
      expect(await composition.storage.inspectObject(tenant, composition.hash)).toBeUndefined();
      expect(await composition.core.quota.readUsage(tenant)).toMatchObject({ committedObjectBytes: 0n, objectCount: 0n });
      expect(failure).toMatchObject({ failedRows: 0, committed: { removed: 1, expired: 0, releasedBytes: composition.size } });
      expect(failure.more).toBeUndefined();
    } finally { hook.mockRestore(); await composition.scope.dispose(); }
  });
  it('deletes bytes and settles accounted storage exactly once through the deployed factory', async () => {
    const composition = await setup();
    try {
      expect(await composition.core.objects.collectExpired(tenant, composition.bounds)).toEqual({ removed: 1, expired: 0, releasedBytes: composition.size, more: false });
      expect(await composition.storage.inspectObject(tenant, composition.hash)).toBeUndefined();
      expect(await composition.core.quota.readUsage(tenant)).toMatchObject({ committedObjectBytes: 0n, objectCount: 0n });
      expect(await composition.core.objects.collectExpired(tenant, composition.bounds)).toEqual({ removed: 0, expired: 0, releasedBytes: 0n, more: false });
    } finally { await composition.scope.dispose(); }
  });
  it('retries physical DELETE response loss without double releasing accounted bytes', async () => {
    let fail = true;
    const composition = await setup(async request => {
      const response = await fetch(request);
      if (request.method === 'DELETE' && fail) { fail = false; throw new Error('DELETE response lost after commit'); }
      return response;
    });
    try {
      await expect(composition.collector.collectExpired(tenant, composition.bounds)).rejects.toMatchObject({ failedRows: 1, committed: { removed: 0, releasedBytes: 0n }, more: true });
      expect(await composition.storage.inspectObject(tenant, composition.hash)).toBeUndefined();
      expect(await composition.core.objects.get(tenant, composition.hash)).toMatchObject({ state: 'delete_pending' });
      expect(await composition.core.quota.readUsage(tenant)).toMatchObject({ committedObjectBytes: composition.size });
      expect(await composition.collector.collectExpired(tenant, composition.bounds)).toEqual({ removed: 1, expired: 0, releasedBytes: composition.size, more: false });
    } finally { await composition.scope.dispose(); }
  });
  it('holds the same-hash row across physical delete while unrelated admission proceeds', async () => {
    let entered!: () => void;
    let release!: () => void;
    const entry = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let deletes = 0;
    const composition = await setup(async request => { if (request.method === 'DELETE') { deletes++; entered(); await gate; } return fetch(request); });
    const collecting = composition.collector.collectExpired(tenant, composition.bounds);
    let exiting: Promise<unknown> | undefined;
    try {
      await entry;
      exiting = composition.core.objects.markDeleted(tenant, composition.hash);
      const exitingCheck = expect(exiting).rejects.toMatchObject({
        code: 'object_state_invalid', message: 'deleted to deleted is not a legal object manifest transition.',
      });
      await until(async () => (await composition.scope.pool.query(`SELECT 1 FROM pg_stat_activity WHERE usename = current_user AND wait_event_type = 'Lock' AND query LIKE '%UPDATE object_manifest%'`)).rowCount !== 0);
      const admitted = await composition.core.quota.reserve(tenant, { reservationId: 'unrelated', kind: 'object', expectedBytes: 1n, contentHash: contentHash('sha256:' + 'f'.repeat(64)), contentType: 'text/plain', ttlMs: 60_000 });
      expect(admitted.state).toBe('reserved');
      expect(await composition.collector.collectExpired(tenant, composition.bounds)).toEqual({ removed: 0, expired: 0, releasedBytes: 0n, more: true });
      expect(deletes).toBe(1);
      release();
      expect(await collecting).toEqual({ removed: 1, expired: 0, releasedBytes: composition.size, more: false });
      await exitingCheck;
      await composition.core.quota.abortReservation(tenant, 'unrelated');
      await composition.upload('recreated');
      expect(await composition.storage.inspectObject(tenant, composition.hash)).toBeDefined();
      expect(await composition.core.objects.get(tenant, composition.hash)).toMatchObject({ state: 'committed' });
    } finally { release(); await collecting.catch(() => {}); await exiting?.catch(() => {}); await composition.scope.dispose(); }
  });
  it('aborts the maintenance HTTP boundary at its configured request timeout', async () => {
    const config = (await createObjectStorageScope()).config;
    const storage = new R2ObjectMaintenanceStore({ ...config, maxAttempts: 1, requestTimeoutMs: 20, fetch: request => new Promise((_resolve, reject) => { request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }); }) });
    await expect(storage.deleteObject(tenant, contentHash('sha256:' + 'a'.repeat(64)))).rejects.toMatchObject({ attempts: 1 });
  });
});
