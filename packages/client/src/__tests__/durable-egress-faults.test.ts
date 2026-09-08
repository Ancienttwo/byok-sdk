import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { AgentMessageOutbox } from '../daemon/agent-message-outbox';
import { AgentReliableSpool } from '../daemon/agent-egress-spool';
import { DEFAULT_AGENT_EGRESS_POLICY as policy } from '../daemon/agent-egress-policy';
import { CursorStore } from '../daemon/cursor-store';

const roots: string[] = [];
const agentRef = { agentId: 'agent-one', profileRevision: '1' };
const draft = { taskId: 'task-one', tenantId: 'tenant-one', agentRef,
  requirement: { mode: 'required', contract: 'chat.v1', contentType: 'text/markdown', maxBytes: 100_000 } as const,
  contentType: 'text/markdown' as const, body: 'hello', maxPendingEvents: 64, maxPendingBytes: 4 * 1024 * 1024 };
const event = { tenantId: 'tenant-one', agentRef, policyRevision: policy.policyRevision,
  eventId: '11111111-1111-4111-8111-111111111111', payload: { text: 'hello' }, sessionRef: 'session-one' };
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function home() { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-durable-fault-')); roots.push(root); return root; }

for (const kind of ['outbox', 'spool'] as const) {
  test.each(['write', 'sync', 'close'] as const)(`${kind}: %s failure after bytes quarantines writer; reopen preserves one identity`, async (phase) => {
    const root = await home();
    const store = kind === 'outbox' ? await AgentMessageOutbox.open(root) : await AgentReliableSpool.open(root);
    const file = store instanceof AgentMessageOutbox ? store.outboxPath : store.spoolPath;
    const append = () => store instanceof AgentMessageOutbox ? store.appendDraft(draft) : store.append(event, policy, 0);
    const realOpen = fs.open.bind(fs);
    let injected = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (String(args[0]) === file && !injected) {
        const real = handle[phase].bind(handle) as (...args: any[]) => Promise<any>;
        vi.spyOn(handle, phase).mockImplementation(async (...values: any[]) => {
          if (phase === 'sync' && !injected) { injected = true; throw new Error('injected sync EIO'); }
          const result = await real(...values);
          if (!injected) { injected = true; throw new Error(`injected ${phase} EIO`); }
          return result;
        });
      }
      return handle;
    });
    await expect(append()).rejects.toThrow(/injected/);
    vi.restoreAllMocks();
    await expect(append()).rejects.toThrow(/quarantined/);
    const rows = (await fs.readFile(file, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(rows).toHaveLength(1);
    const reopened = kind === 'outbox' ? await AgentMessageOutbox.open(root) : await AgentReliableSpool.open(root);
    const retried = reopened instanceof AgentMessageOutbox ? await reopened.appendDraft(draft) : await reopened.append(event, policy, 0);
    expect(retried).toEqual(rows[0].record);
    expect((await fs.readFile(file, 'utf8')).trim().split('\n')).toHaveLength(1);
    await expect(reopened instanceof AgentMessageOutbox ? reopened.appendDraft({ ...draft, body: 'conflict' }) : reopened.append({ ...event, payload: { text: 'conflict' } }, policy, 0)).rejects.toThrow(/different|differs/);
  });
}

test('cursor save waits for the durable file barrier and propagates failure', async () => {
  const root = await home();
  const store = new CursorStore(root);
  const realOpen = fs.open.bind(fs);
  let syncCalls = 0;
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    vi.spyOn(handle, 'sync').mockImplementation(async () => { syncCalls++; throw new Error('cursor sync EIO'); });
    return handle;
  });
  await expect(store.save('https://example.test', 'device', 3)).rejects.toThrow('cursor sync EIO');
  expect(syncCalls).toBe(1);
  vi.restoreAllMocks();
  await store.save('https://example.test', 'device', 3);
  expect(await store.load('https://example.test', 'device')).toBe(3);
});

test('refused history does not consume sending event or byte quotas after reopen', async () => {
  const root = await home();
  let outbox = await AgentMessageOutbox.open(root);
  for (let i = 0; i < 65; i++) {
    const record = await outbox.appendDraft({ ...draft, taskId: `refused-${i}`, sessionRef: 'session-one', maxPendingEvents: 1, maxPendingBytes: 5 });
    await outbox.applyDisposition(record.taskId, { agentRef, sessionRef: 'session-one', contract: record.contract,
      messageId: record.messageId, cursor: record.cursor, contentHash: record.contentHash,
      outcome: 'refused', receiptId: '11111111-1111-4111-8111-111111111111', reasonCode: 'not-allowed' });
    if (i === 32) outbox = await AgentMessageOutbox.open(root);
  }
  expect(outbox.records()).toHaveLength(65);
  expect(outbox.retryableRecords()).toHaveLength(0);
  outbox = await AgentMessageOutbox.open(root);
  await expect(outbox.appendDraft({ ...draft, maxPendingEvents: 1, maxPendingBytes: 5 })).resolves.toBeDefined();
});

for (const kind of ['outbox', 'spool'] as const) {
  test(`${kind}: a partial write is preserved and rejected on reopen; successful short writes are completed`, async () => {
    const root = await home();
    const store = kind === 'outbox' ? await AgentMessageOutbox.open(root) : await AgentReliableSpool.open(root);
    const file = store instanceof AgentMessageOutbox ? store.outboxPath : store.spoolPath;
    const realOpen = fs.open.bind(fs);
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (String(args[0]) === file) {
        const write = handle.write.bind(handle);
        vi.spyOn(handle, 'write').mockImplementation(async (buffer: any, offset: any, length: any) => {
          await write(buffer, offset, Math.min(7, length));
          throw new Error('partial write EIO');
        });
      }
      return handle;
    });
    await expect(store instanceof AgentMessageOutbox ? store.appendDraft(draft) : store.append(event, policy, 0)).rejects.toThrow('partial write EIO');
    vi.restoreAllMocks();
    const bytes = await fs.readFile(file);
    expect(bytes.length).toBe(7);
    await expect(kind === 'outbox' ? AgentMessageOutbox.open(root) : AgentReliableSpool.open(root)).rejects.toThrow(/incomplete trailing frame/);
    expect(await fs.readFile(file)).toEqual(bytes);

    const cleanRoot = await home();
    const clean = kind === 'outbox' ? await AgentMessageOutbox.open(cleanRoot) : await AgentReliableSpool.open(cleanRoot);
    const cleanFile = clean instanceof AgentMessageOutbox ? clean.outboxPath : clean.spoolPath;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (String(args[0]) === cleanFile) {
        const write = handle.write.bind(handle);
        vi.spyOn(handle, 'write').mockImplementation((buffer: any, offset: any, length: any) => write(buffer, offset, Math.min(7, length)));
      }
      return handle;
    });
    const record = clean instanceof AgentMessageOutbox ? await clean.appendDraft(draft) : await clean.append(event, policy, 0);
    vi.restoreAllMocks();
    expect((kind === 'outbox' ? await AgentMessageOutbox.open(cleanRoot) : await AgentReliableSpool.open(cleanRoot)).records()).toEqual([record]);
  });

  test.each(['temp', 'target', 'directory'] as const)(`${kind}: natural compaction propagates %s sync failure and quarantines the replacement`, async (phase) => {
    if (phase === 'directory' && process.platform === 'win32') return;
    const root = await home();
    const store = kind === 'outbox' ? await AgentMessageOutbox.open(root) : await AgentReliableSpool.open(root);
    const file = store instanceof AgentMessageOutbox ? store.outboxPath : store.spoolPath;
    const append = (id: string) => store instanceof AgentMessageOutbox
      ? store.appendDraft({ ...draft, taskId: id, sessionRef: 'session-one' })
      : store.append({ ...event, eventId: id }, policy, 0);
    const settle = async (record: any) => store instanceof AgentMessageOutbox
      ? store.applyDisposition(record.taskId, { agentRef, sessionRef: 'session-one', contract: record.contract,
        messageId: record.messageId, cursor: record.cursor, contentHash: record.contentHash,
        outcome: 'accepted', receiptId: '11111111-1111-4111-8111-111111111111' })
      : store.acknowledge({ agentRef, tenantId: record.tenantId, sessionRef: 'session-one', policyRevision: record.policyRevision, eventId: record.eventId, cursor: record.cursor });
    for (let i = 0; i < 255; i++) await settle(await append(`cycle-${i}`));
    const retained = await append('retained');
    const final = await append('final');
    const realOpen = fs.open.bind(fs);
    const rename = fs.rename.bind(fs);
    let replaced = false;
    vi.spyOn(fs, 'rename').mockImplementation(async (...args) => { await rename(...args); replaced = true; });
    let syncFailed = false;
    vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      const target = String(args[0]);
      const selected = phase === 'temp' ? target.endsWith('.tmp')
        : phase === 'target' ? target === file && replaced
        : target === path.dirname(file) && replaced;
      if (selected) vi.spyOn(handle, 'sync').mockImplementation(async () => { syncFailed = true; throw new Error(`compact ${phase} EIO`); });
      return handle;
    });
    await expect(settle(final)).rejects.toThrow(`compact ${phase} EIO`);
    expect(syncFailed).toBe(true);
    vi.restoreAllMocks();
    await expect(append('blocked')).rejects.toThrow(/quarantined/);
    expect((kind === 'outbox' ? await AgentMessageOutbox.open(root) : await AgentReliableSpool.open(root)).records()).toEqual([retained]);
  }, 60_000); // Natural threshold preparation retains real file/directory syncs.
}

test('reopen does not expose recovered records until their sync succeeds', async () => {
  const root = await home();
  const store = await AgentMessageOutbox.open(root);
  await store.appendDraft(draft);
  const realOpen = fs.open.bind(fs);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    if (String(args[0]) === store.outboxPath) vi.spyOn(handle, 'sync').mockImplementation(async () => { entered(); await gate; throw new Error('recovery EIO'); });
    return handle;
  });
  let settled = false;
  const reopening = AgentMessageOutbox.open(root).finally(() => { settled = true; });
  const rejected = expect(reopening).rejects.toThrow('recovery EIO');
  await reached;
  expect(settled).toBe(false);
  release();
  await rejected;
});

test('explicit archive preserves refused evidence and leaves held and pending records live', async () => {
  const root = await home();
  const outbox = await AgentMessageOutbox.open(root);
  for (const outcome of ['refused', 'held'] as const) {
    const record = await outbox.appendDraft({ ...draft, taskId: outcome, sessionRef: 'session-one' });
    await outbox.applyDisposition(outcome, { agentRef, sessionRef: 'session-one', contract: record.contract,
      messageId: record.messageId, cursor: record.cursor, contentHash: record.contentHash,
      outcome, receiptId: '11111111-1111-4111-8111-111111111111', reasonCode: 'test-reason' });
  }
  await outbox.appendDraft(draft);
  const archiveDir = path.join(root, 'audit');
  const archive = await outbox.archiveTerminalRecords(archiveDir);
  expect(archive).toBeDefined();
  const audit = (await fs.readFile(archive!, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(audit).toMatchObject([{ kind: 'append', record: { taskId: 'refused', body: 'hello' } },
    { kind: 'disposition', disposition: { outcome: 'refused', reasonCode: 'test-reason' } }]);
  const reopened = await AgentMessageOutbox.open(root);
  expect(reopened.records().map(record => record.taskId)).toEqual(['held', 'task-one']);
  expect(reopened.retryableRecords().map(record => record.taskId)).toEqual(['task-one']);
  expect(await reopened.archiveTerminalRecords(archiveDir)).toBeUndefined();
});

test('archive sync failure retains all live evidence', async () => {
  const root = await home();
  const outbox = await AgentMessageOutbox.open(root);
  await outbox.appendDraft(draft);
  await outbox.revoke(draft.taskId);
  const realOpen = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    if (String(args[0]).endsWith('.tmp')) vi.spyOn(handle, 'sync').mockRejectedValue(new Error('archive sync EIO'));
    return handle;
  });
  await expect(outbox.archiveTerminalRecords(path.join(root, 'audit'))).rejects.toThrow('archive sync EIO');
  vi.restoreAllMocks();
  const reopened = await AgentMessageOutbox.open(root);
  expect(reopened.records()).toHaveLength(1);
  expect(reopened.retryableRecords()).toHaveLength(0);
});

test.each(['temp', 'target', 'directory'] as const)('cursor durable receipt waits for %s sync and propagates failure', async (phase) => {
  if (phase === 'directory' && process.platform === 'win32') return;
  const root = await home();
  const store = new CursorStore(root);
  const realOpen = fs.open.bind(fs);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    const file = String(args[0]);
    const selected = phase === 'temp' ? file.endsWith('.tmp') : phase === 'target' ? file.endsWith('.json') : file === root;
    if (selected) vi.spyOn(handle, 'sync').mockImplementation(async () => { entered(); await gate; throw new Error(`cursor ${phase} EIO`); });
    return handle;
  });
  let settled = false;
  const saving = store.save('https://example.test', 'device', 7).finally(() => { settled = true; });
  const rejected = expect(saving).rejects.toThrow(`cursor ${phase} EIO`);
  await reached;
  expect(settled).toBe(false);
  release();
  await rejected;
});

test('cursor Windows branch syncs temporary and writable target handles', async () => {
  const root = await home();
  const store = new CursorStore(root);
  const platform = process.platform;
  const realOpen = fs.open.bind(fs);
  const synced: Array<{ file: string; flags: unknown }> = [];
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await realOpen(...args);
    const sync = handle.sync.bind(handle);
    vi.spyOn(handle, 'sync').mockImplementation(async () => { synced.push({ file: String(args[0]), flags: args[1] }); await sync(); });
    return handle;
  });
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
  try { await store.save('https://example.test', 'device', 9); }
  finally { Object.defineProperty(process, 'platform', { configurable: true, value: platform }); }
  expect(synced).toHaveLength(2);
  expect(synced[0]!.file.endsWith('.tmp')).toBe(true);
  expect(synced[1]).toMatchObject({ flags: 'r+' });
  expect(await store.load('https://example.test', 'device')).toBe(9);
});
