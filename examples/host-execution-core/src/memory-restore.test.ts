import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentMemoryExport } from '@byok-sdk/protocol';
import {
  HostLedger,
  MIN_TOMBSTONE_RETENTION_MS,
  HostMemoryPage,
  memoryRevision,
  MemoryBlockedError,
  HostExecutionCore,
  enqueue,
  type MemoryOptions,
  type MemoryRestoreInput,
  type MemoryRestoreResult,
  type ExecutionServer,
} from '@byok-sdk/server/execution-core';
import { template } from './test-support';
const binding = { deviceId: 'device', agentRef: { agentId: 'main', profileRevision: '1' } };
function snapshot(values: Record<string, string>): AgentMemoryExport {
  const files = Object.entries(values).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([path, content]) => ({ path, content, revision: memoryRevision(content), byteCount: Buffer.byteLength(content) }));
  return { requestedAgentRef: binding.agentRef, files, totalBytes: files.reduce((sum, file) => sum + file.byteCount, 0),
    snapshotDigest: memoryRevision(JSON.stringify(['byok-agent-memory-export.v1', files.map(file => [file.path, file.revision, file.byteCount])])) };
}
const target = snapshot({ 'MEMORY.md': 'restored root', 'notes/a.md': 'restored A', 'notes/b.md': 'restored B' });
let root: string, filename: string, ledger: HostLedger, page: HostMemoryPage;
let options: MemoryOptions;
let current = snapshot({ 'MEMORY.md': '' });
function input(rest: Partial<MemoryRestoreInput> = {}): MemoryRestoreInput {
  return { ...binding, restoreId: 'restore-1', mode: 'initial', files: target.files, expiresAt: 5000, ...rest };
}
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'byok-restore-')); filename = path.join(root, 'host.sqlite');
  ledger = new HostLedger(filename, 'product:test'); current = snapshot({ 'MEMORY.md': '' });
  options = { now: () => 1000, isCurrent: () => true, notify: vi.fn(async () => {}), authorizeProjection: () => true,
    exportMemory: vi.fn(async () => current) };
  page = new HostMemoryPage(ledger, options);
});
afterEach(async () => { ledger.close(); await rm(root, { recursive: true, force: true }); });
function reopen() { ledger.close(); ledger = new HostLedger(filename, 'product:test'); page = new HostMemoryPage(ledger, options); }
async function complete(file: MemoryRestoreResult['files'][number], outcome: 'applied' | 'conflict' | 'uncertain' = 'applied') {
  const row = page.intent(file.intentId!)!; const intent = row.intent;
  const port = page.transport(binding.deviceId);
  await port.fetch({ intentId: intent.intentId, agentRef: binding.agentRef, reservation: 'held' });
  const identity = { intentId: intent.intentId, agentRef: intent.agentRef, path: intent.path, operation: intent.operation, operationDigest: intent.operationDigest };
  await port.complete(outcome === 'applied' ? { ...identity, outcome, result: { exists: intent.operation === 'replace', revision: intent.targetRevision ?? memoryRevision('') } }
    : { ...identity, outcome, observed: { exists: true, revision: memoryRevision('concurrent change') } });
}
it('holds the gate across all readbacks and preserves stable retry identity across reopen', async () => {
  const first = await page.restore(input());
  expect(first.status).toBe('applying'); expect(first.files).toHaveLength(3);
  expect(() => page.contextPack(binding)).toThrow(MemoryBlockedError);
  await expect(page.approve({ ...binding, approvalRef: 'manual', path: 'notes/c.md', operation: 'replace', content: 'x', expiresAt: 5000 })).rejects.toThrow('restore');
  expect(await page.restore(input())).toEqual(first);
  await expect(page.restore(input({ files: snapshot({ 'MEMORY.md': 'different' }).files }))).rejects.toThrow('identity conflict');
  await complete(first.files[0]!); reopen(); await page.recoverRestores();
  expect(page.restoreResult(binding, 'restore-1')!.files[0]!.outcome).toBe('applied');
  expect(() => page.contextPack(binding)).toThrow(MemoryBlockedError);
  for (const file of first.files.slice(1)) await complete(file);
  expect(page.restoreResult(binding, 'restore-1')!.status).toBe('applied');
  expect(page.contextPack(binding)).toEqual({});
  const ids = Object.keys(ledger.snapshot().memory!.intents);
  await page.restore(input()); await complete(first.files[0]!);
  expect(Object.keys(ledger.snapshot().memory!.intents)).toEqual(ids);
  expect(Object.values(ledger.snapshot().memory!.intents).every(row => !('content' in row.intent))).toBe(true);
});
it('compacts restore intents only after the restore is terminal and keeps its result', async () => {
  const first = await page.restore(input());
  await complete(first.files[0]!);
  const compact = (ids: string[]) => ledger.compact({ acknowledgedIntentKeys: [], acknowledgedMemoryIntentIds: ids,
    now: 1000, tombstoneRetentionMs: MIN_TOMBSTONE_RETENTION_MS });
  const before = ledger.snapshot();
  expect(() => compact([first.files[0]!.intentId!])).toThrow('active restore');
  expect(ledger.snapshot()).toEqual(before);
  for (const file of first.files.slice(1)) await complete(file);
  const result = page.restoreResult(binding, 'restore-1')!;
  expect(result.status).toBe('applied');
  expect(compact(first.files.map(file => file.intentId!)).memoryIntents).toBe(3);
  expect(ledger.snapshot().memory!.intents).toEqual({}); expect(ledger.snapshot().memory!.approvals).toEqual({});
  expect(page.restoreResult(binding, 'restore-1')).toEqual(result);
  expect(await page.restore(input())).toEqual(result);
  expect(ledger.snapshot().memory!.intents).toEqual({});
});
it('initial nonempty home conflicts as a batch without minting any write, including absent target notes', async () => {
  current = snapshot({ 'MEMORY.md': 'existing' });
  const result = await page.restore(input());
  expect(result.status).toBe('conflict'); expect(result.files.every(file => file.outcome === 'conflict' && !file.intentId)).toBe(true);
  expect(ledger.snapshot().memory!.intents).toEqual({}); expect(page.contextPack(binding)).toEqual({});
});
it('overwrite freezes approved bases, deletes omitted notes, and skips unchanged files', async () => {
  current = snapshot({ 'MEMORY.md': 'old', 'notes/extra.md': 'delete me', 'notes/a.md': 'restored A' });
  const original = current;
  const result = await page.restore(input({ mode: 'overwrite', observed: original }));
  expect(result.files.find(file => file.path === 'notes/a.md')!.outcome).toBe('unchanged');
  const deleted = page.intent(result.files.find(file => file.path === 'notes/extra.md')!.intentId!)!;
  expect(deleted.intent).toMatchObject({ operation: 'delete', baseRevision: memoryRevision('delete me') });
  for (const file of result.files.filter(file => file.intentId)) await complete(file);
  expect(page.restoreResult(binding, 'restore-1')!.status).toBe('applied');
});
it('never silently refreshes an approved overwrite observation', async () => {
  const approved = current; current = snapshot({ 'MEMORY.md': 'changed later' });
  expect((await page.restore(input({ mode: 'overwrite', observed: approved }))).status).toBe('conflict');
  expect(ledger.snapshot().memory!.intents).toEqual({});
});
it('persists preparing before export; explicit cancellation fences a late export result', async () => {
  let release!: (value: AgentMemoryExport) => void;
  options.exportMemory = vi.fn(() => new Promise<AgentMemoryExport>(resolve => { release = resolve; }));
  const pending = page.restore(input());
  expect(page.restoreResult(binding, 'restore-1')!.status).toBe('preparing');
  expect(() => page.contextPack(binding)).toThrow(MemoryBlockedError);
  expect((await page.cancelRestore(binding, 'restore-1')).status).toBe('cancelled');
  release(current);
  expect((await pending).status).toBe('cancelled'); expect(ledger.snapshot().memory!.intents).toEqual({});
  expect(page.contextPack(binding)).toEqual({});
});
it('recovers a gate/preflight failure from durable input and never auto-releases applying on expiry', async () => {
  options.exportMemory = vi.fn(async () => { throw new Error('synthetic interruption'); });
  await expect(page.restore(input())).rejects.toThrow('interruption'); reopen();
  expect(page.restoreResult(binding, 'restore-1')!.status).toBe('preparing');
  options.exportMemory = vi.fn(async () => current); await page.recoverRestores();
  const result = page.restoreResult(binding, 'restore-1')!; expect(result.status).toBe('applying');
  options.now = () => 6000; reopen(); await page.recoverRestores();
  expect(() => page.contextPack(binding)).toThrow(MemoryBlockedError);
  await expect(page.cancelRestore(binding, 'restore-1')).rejects.toThrow('cannot be cancelled');
  for (const file of result.files) await page.transport(binding.deviceId).fetch({ intentId: file.intentId!, agentRef: binding.agentRef, reservation: 'held' });
  expect(page.restoreResult(binding, 'restore-1')!.status).toBe('rejected');
});
it('retains mixed conflict/uncertain outcomes without reminting or a rollback claim', async () => {
  const result = await page.restore(input());
  await complete(result.files[0]!); await complete(result.files[1]!, 'conflict'); await complete(result.files[2]!, 'uncertain');
  expect(page.restoreResult(binding, 'restore-1')!.status).toBe('uncertain');
  expect(page.restoreResult(binding, 'restore-1')!.files.map(file => file.outcome)).toEqual(['applied', 'conflict', 'uncertain']);
  expect((await page.restore(input())).files.map(file => file.intentId)).toEqual(result.files.map(file => file.intentId));
});
it('refuses inflight K4 execution and pending manual intent before creating the gate', async () => {
  ledger.transaction(state => { const row = enqueue(state, ledger.tenant, { key: 'running', source: 'user', execution: template(binding.deviceId), waitUntil: 5000 }); row.phase = 'inflight'; });
  await expect(page.restore(input())).rejects.toThrow('busy'); expect(page.restoreResult(binding, 'restore-1')).toBeUndefined();
  ledger.transaction(state => { for (const row of Object.values(state.intents)) row.phase = 'queued'; });
  await page.approve({ ...binding, approvalRef: 'manual', path: 'notes/x.md', operation: 'replace', content: 'x', expiresAt: 5000 });
  await expect(page.restore(input())).rejects.toThrow('busy');
});
it('rejects malformed tree/observation and oversized input before acquiring a gate', async () => {
  await expect(page.restore(input({ files: [{ ...target.files[0]!, revision: memoryRevision('wrong') }] }))).rejects.toThrow('Invalid restore file');
  await expect(page.restore(input({ mode: 'overwrite' }))).rejects.toThrow('identity mismatch');
  await expect(page.restore(input({ files: snapshot({ 'MEMORY.md': 'x'.repeat(256 * 1024 + 1) }).files }))).rejects.toThrow('Invalid restore file');
  expect(ledger.snapshot().memory?.restores).toBeUndefined();
});

it.each(['gate', 'preflight', 'intentcommit', 'readback'])('recovers after SIGKILL of the owned synthetic Host process at %s', async stage => {
  ledger.close();
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('./fixtures/memory-restore-crash.ts', import.meta.url)), filename, stage], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = ''; child.stderr.on('data', value => { stderr += String(value); });
  const exited = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('exit', () => resolve()); });
  try {
    await new Promise<void>((resolve, reject) => {
      let output = ''; const timer = setTimeout(() => reject(new Error(`Crash fixture stage timeout: ${stderr}`)), 5000);
      child.stdout.on('data', value => { output += String(value); if (output.includes('durable-stage')) { clearTimeout(timer); resolve(); } });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`Crash fixture exited early: ${stderr}`)); });
    });
    child.kill('SIGKILL'); await exited;
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    ledger = new HostLedger(filename, 'product:test'); page = new HostMemoryPage(ledger, options);
  }
  expect(() => page.contextPack(binding)).toThrow(MemoryBlockedError);
  await page.recoverRestores();
  const recovered = page.restoreResult(binding, 'crash-restore')!;
  expect(recovered.status).toBe('applying'); expect(recovered.files).toHaveLength(3);
  if (stage === 'readback') expect(recovered.files[0]!.outcome).toBe('applied');
  for (const file of recovered.files) if (file.outcome === 'pending') await complete(file);
  expect(page.restoreResult(binding, 'crash-restore')!.status).toBe('applied');
});

it('requires the same ledger instance for restore-enabled core composition, even for the same database file', () => {
  const other = new HostLedger(filename, ledger.tenant);
  try { expect(() => new HostExecutionCore({} as ExecutionServer, other, { memory: page })).toThrow('same HostLedger instance'); }
  finally { other.close(); }
});
it('retains the gate after malformed export and recovers without committing an unverified tree', async () => {
  options.exportMemory = async () => ({ ...current, snapshotDigest: memoryRevision('forged') });
  await expect(page.restore(input())).rejects.toThrow('digest mismatch');
  expect(ledger.snapshot().memory!.intents).toEqual({}); expect(() => page.contextPack(binding)).toThrow(MemoryBlockedError);
  options.exportMemory = async () => current; await page.recoverRestores();
  expect(page.restoreResult(binding, 'restore-1')!.status).toBe('applying');
});
it('does not retain a ledger binding when core construction rejects its configuration', async () => {
  options.exportMemory = undefined;
  const other = new HostLedger(filename, ledger.tenant);
  try { expect(() => new HostExecutionCore({} as ExecutionServer, other, { memory: page, reconcileMs: 0 })).toThrow('positive'); }
  finally { other.close(); }
  options.exportMemory = async () => current;
  expect((await page.restore(input())).status).toBe('applying');
});
