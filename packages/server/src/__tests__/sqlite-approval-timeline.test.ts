import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createMutableClock, tenantId } from '@byok-sdk/core';
import { createWebCrypto } from '@byok-sdk/cloud';
import { createSqliteEmbeddedStores, type SqliteEmbeddedStores } from '../stores/sqlite';

const tenant = tenantId('approval-reopen');
const request = {
  taskId: 'task', sourceEnvelopeId: 'request-1',
  event: { type: 'approval_requested', approvalId: 'approval-1', summary: 'Allow write?' },
} as const;

describe('SQLite approval timeline persistence', () => {
  const roots: string[] = [];
  const opened = new Set<SqliteEmbeddedStores>();
  afterEach(async () => {
    for (const store of opened) await store.close();
    opened.clear();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'approval-reopen-'));
    roots.push(root);
    const path = join(root, 'state.sqlite');
    const clock = createMutableClock(new Date('2026-10-27T00:00:00.000Z'));
    const open = () => {
      const store = createSqliteEmbeddedStores({ path }, { clock, crypto: createWebCrypto() });
      opened.add(store);
      return store;
    };
    const close = async (store: SqliteEmbeddedStores) => { await store.close(); opened.delete(store); };
    return { path, clock, open, close };
  }

  it('keeps a pending request and its exact resolution identity across reopen', async () => {
    const { clock, open, close } = fixture();
    const first = open();
    const original = await first.cloud.approvals.append(tenant, request);
    await close(first);
    clock.advance(1_000);
    const second = open();
    expect(await second.cloud.approvals.read(tenant, request.taskId)).toEqual(original);
    const decision = {
      taskId: request.taskId, sourceEnvelopeId: 'host-decision',
      expectedSourceEnvelopeId: request.sourceEnvelopeId, expectedRevision: 1,
      event: { type: 'approval_resolved', approvalId: 'approval-1', decision: 'approve', resolvedBy: 'host', at: clock.now().toISOString() },
    } as const;
    const resolved = await second.cloud.approvals.resolvePending(tenant, decision);
    expect(resolved.status).toBe('applied');
    await close(second);
    const third = open();
    expect(await third.cloud.approvals.resolvePending(tenant, decision)).toMatchObject({ status: 'replayed', tail: { cursor: 2 } });
  });

  it('does not refresh expiry on reopen or replay and expires at the exact TTL boundary', async () => {
    const { clock, open, close } = fixture();
    const first = open();
    const tail = await first.cloud.approvals.append(tenant, request);
    await close(first);
    clock.advance(599_999);
    const second = open();
    expect(await second.cloud.approvals.append(tenant, request)).toEqual(tail);
    await close(second);
    clock.advance(1);
    const third = open();
    expect(await third.cloud.approvals.resolvePending(tenant, {
      taskId: 'task', sourceEnvelopeId: 'expired-resolution', expectedSourceEnvelopeId: 'request-1', expectedRevision: 1,
      event: { type: 'approval_resolved', approvalId: 'approval-1', resolvedBy: 'host', decision: 'approve', at: clock.now().toISOString() },
    })).toEqual({ status: 'absent' });
    expect(await third.cloud.approvals.read(tenant, 'task')).toBeUndefined();
    expect((await third.cloud.approvals.append(tenant, { ...request, sourceEnvelopeId: 'new-request' })).cursor).toBe(1);
  });

  it('persists bounded tails and collects expired rows by tenant and limit', async () => {
    const { clock, open, close } = fixture();
    const first = open();
    for (const id of ['task', 'another']) {
      for (let i = 0; i < 3; i++) await first.cloud.approvals.append(tenant, {
        ...request, taskId: id, sourceEnvelopeId: `request-${i}`, capacity: 2,
      });
    }
    const other = tenantId('other');
    await first.cloud.approvals.append(other, request);
    await close(first);
    const second = open();
    expect(await second.cloud.approvals.read(tenant, 'task')).toMatchObject({ cursor: 3, dropped: 1, capacity: 2 });
    clock.advance(600_000);
    expect(await second.cloud.approvals.collectExpired(tenant, { now: clock.now().toISOString(), limit: 1 })).toMatchObject({ removed: 1, more: true });
    expect(await second.cloud.approvals.collectExpired(tenant, { now: clock.now().toISOString(), limit: 1 })).toMatchObject({ removed: 1, more: false });
    expect(await second.cloud.approvals.collectExpired(other, { now: clock.now().toISOString(), limit: 1 })).toMatchObject({ removed: 1, more: false });
  });

  it('serializes competing decisions and preserves the winning event on reopen', async () => {
    const { clock, open, close } = fixture();
    const first = open();
    await first.cloud.approvals.append(tenant, request);
    const common = { taskId: 'task', expectedSourceEnvelopeId: 'request-1', expectedRevision: 1 };
    const [approve, reject] = await Promise.all([
      first.cloud.approvals.resolvePending(tenant, { ...common, sourceEnvelopeId: 'approve', event: {
        type: 'approval_resolved', approvalId: 'approval-1', resolvedBy: 'host', decision: 'approve', at: clock.now().toISOString(),
      } }),
      first.cloud.approvals.resolvePending(tenant, { ...common, sourceEnvelopeId: 'reject', event: {
        type: 'approval_resolved', approvalId: 'approval-1', resolvedBy: 'host', decision: 'reject', reason: null, at: clock.now().toISOString(),
      } }),
    ]);
    expect(approve.status).toBe('applied');
    expect(reject.status).toBe('absent');
    await close(first);
    expect((await open().cloud.approvals.read(tenant, 'task'))?.entries.at(-1)?.event).toMatchObject({ decision: 'approve' });
  });

  it.each(['1', '2', '3', '4', '5', '999'])('refuses schema %s without changing its recorded authority', async version => {
    const { path, open, close } = fixture();
    const first = open(); await first.cloud.approvals.append(tenant, request); await close(first);
    const db = new DatabaseSync(path);
    db.prepare("UPDATE byok_sqlite_meta SET value = ? WHERE key = 'schema_version'").run(version);
    const before = db.prepare('SELECT * FROM approval_timeline_tail').all(); db.close();
    expect(() => open()).toThrow(expect.objectContaining({ code: 'SQLITE_SCHEMA_UNSUPPORTED', foundVersion: version, requiredVersion: '8' }));
    const inspect = new DatabaseSync(path, { readOnly: true });
    try {
      expect(inspect.prepare("SELECT value FROM byok_sqlite_meta WHERE key = 'schema_version'").get()?.value).toBe(version);
      expect(inspect.prepare('SELECT * FROM approval_timeline_tail').all()).toEqual(before);
    } finally { inspect.close(); }
  });

  it('rejects a removed migration option without opening or changing the file', async () => {
    const { path, clock, open, close } = fixture();
    const first = open(); await first.cloud.approvals.append(tenant, request); await close(first);
    expect(() => createSqliteEmbeddedStores({ path, ...{ migration: 'v4-to-v5' } }, { clock, crypto: createWebCrypto() }))
      .toThrow('migration selectors are not supported');
    expect((await open().cloud.approvals.read(tenant, 'task'))?.entries[0]?.event).toEqual(request.event);
  });

  it('refuses missing approval authority without recreating it', async () => {
    const { path, open, close } = fixture(); await close(open());
    const db = new DatabaseSync(path); db.exec('DROP TABLE approval_timeline_tail'); db.close();
    expect(() => open()).toThrow(expect.objectContaining({ code: 'SQLITE_SCHEMA_INVALID', foundVersion: '8' }));
    const inspect = new DatabaseSync(path, { readOnly: true });
    try { expect(inspect.prepare("SELECT name FROM sqlite_master WHERE name = 'approval_timeline_tail'").get()).toBeUndefined(); }
    finally { inspect.close(); }
  });

  it('refuses corrupt persisted observations instead of treating them as an empty timeline', async () => {
    const { path, open, close } = fixture(); const first = open();
    await first.cloud.approvals.append(tenant, request); await close(first);
    const db = new DatabaseSync(path); db.exec("UPDATE approval_timeline_tail SET entries_json = '[]'"); db.close();
    await expect(open().cloud.approvals.read(tenant, 'task')).rejects.toThrow('authority is malformed');
  });

});
