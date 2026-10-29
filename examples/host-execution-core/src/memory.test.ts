import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AgentMemoryIntentCompletion, AgentMemoryProjectionMutation } from '@byok-sdk/protocol';
import {
  HostLedger,
  MIN_TOMBSTONE_RETENTION_MS,
  enqueue,
  HostMemoryPage,
  EMPTY_MEMORY_REVISION,
  memoryRevision,
  type MemoryApproval,
} from '@byok-sdk/server/execution-core';
import { openHost, type TestHost } from './test-support';

const agentRef = { agentId: 'main', profileRevision: '1' };
const binding = { deviceId: 'device', agentRef };
let root: string;
let ledger: HostLedger;
let page: HostMemoryPage;
let current = true;
let clock = 1000;
const notify = vi.fn(async () => {});
function options() { return { now: () => clock, isCurrent: () => current, notify,
  authorizeProjection: (_deviceId: string, mutation: AgentMemoryProjectionMutation) => mutation.grantRef === 'approved' }; }
function approval(rest: Partial<MemoryApproval> = {}): MemoryApproval {
  return { ...binding, approvalRef: randomUUID(), path: 'MEMORY.md', operation: 'replace', content: 'new text', expiresAt: 5000, ...rest };
}
function projection(text: string | null, rest: Partial<AgentMemoryProjectionMutation> = {}): AgentMemoryProjectionMutation {
  const bytes = JSON.stringify({ residentMemory: text });
  return { taskId: 'task', agentRef, sessionRef: 'session', runtimeId: 'pi', grantRef: 'approved', writerEpoch: 1, sourceSeq: 1,
    mutationId: randomUUID(), policyRevision: 'policy-1', snapshot: { redactedHash: memoryRevision(bytes),
      redactedByteCount: Buffer.byteLength(bytes), redactedBytes: Buffer.from(bytes).toString('base64url') }, ...rest };
}
function completion(intentId: string, outcome: 'applied' | 'conflict' | 'uncertain' | 'rejected' = 'applied'): AgentMemoryIntentCompletion {
  const { agentRef, path, operation, operationDigest, targetRevision } = page.intent(intentId)!.intent;
  const identity = { intentId, agentRef, path, operation, operationDigest };
  if (outcome === 'applied') return { ...identity, outcome, result: { exists: operation === 'replace', revision: targetRevision ?? EMPTY_MEMORY_REVISION } };
  if (outcome === 'rejected') return { ...identity, outcome, code: 'path_invalid' };
  return { ...identity, outcome, observed: { exists: true, revision: memoryRevision('device changed') } };
}
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'memory-host-'));
  ledger = new HostLedger(path.join(root, 'ledger.sqlite'), 'product:host-core-test');
  current = true; clock = 1000; notify.mockReset();
  page = new HostMemoryPage(ledger, options());
});
afterEach(async () => { ledger.close(); await rm(root, { recursive: true, force: true }); });

it('persists exact approvals and rejects changed reuse without storing extra bodies', async () => {
  const input = approval();
  const row = await page.approve(input);
  expect(row.intent.baseRevision).toBe(EMPTY_MEMORY_REVISION);
  expect(await page.approve(input)).toEqual(row);
  await expect(page.approve({ ...input, content: 'changed' })).rejects.toThrow('identity conflict');
  expect(Object.keys(ledger.snapshot().memory!.intents)).toEqual([row.intent.intentId]);
  await expect(page.approve(approval({ content: 'same', baseRevision: memoryRevision('same') }))).rejects.toThrow();
  await expect(page.approve(approval({ content: '\ud800' }))).rejects.toThrow();
});

it('never releases or changes state without a reservation and refuses another identity', async () => {
  const { intent } = await page.approve(approval());
  const before = ledger.snapshot();
  const fetch = { intentId: intent.intentId, agentRef, reservation: 'none' as const };
  const response = await page.transport('device').fetch(fetch);
  expect(response).toMatchObject({ disposition: 'deferred' });
  expect(response).not.toHaveProperty('intent.content');
  expect(ledger.snapshot()).toEqual(before);
  await expect(page.transport('other-device').fetch(fetch)).rejects.toThrow('identity mismatch');
  await expect(page.transport('device').fetch({ ...fetch, agentRef: { ...agentRef, profileRevision: '2' } })).rejects.toThrow('identity mismatch');
});

it.each(['applied', 'conflict', 'uncertain', 'rejected'] as const)('keeps %s terminal across restart, purges content and returns stable readback', async outcome => {
  const { intent } = await page.approve(approval());
  const transport = page.transport('device');
  await transport.fetch({ intentId: intent.intentId, agentRef, reservation: 'held' });
  const result = completion(intent.intentId, outcome);
  expect(await transport.complete(result)).toMatchObject({ disposition: 'recorded', completion: result });
  expect(page.intent(intent.intentId)!.intent.content).toBeUndefined();
  expect(JSON.stringify(ledger.snapshot())).not.toContain('new text');
  ledger.close(); ledger = new HostLedger(path.join(root, 'ledger.sqlite'), 'product:host-core-test'); page = new HostMemoryPage(ledger, options());
  expect(await page.transport('device').complete(result)).toMatchObject({ disposition: 'idempotent', completion: result });
  const terminal = await page.transport('device').fetch({ intentId: intent.intentId, agentRef, reservation: 'held' });
  expect(terminal).toMatchObject({ disposition: 'terminal', readback: { completion: result } });
  expect(terminal).not.toHaveProperty('intent.content');
  expect(Object.keys(ledger.snapshot().memory!.intents)).toHaveLength(1); // No automatic rebase or second attempt.
});

it('refuses unbound or false applied completions and preserves the first terminal fact', async () => {
  const { intent } = await page.approve(approval());
  const transport = page.transport('device');
  const result = completion(intent.intentId);
  await expect(transport.complete(result)).rejects.toThrow('not released');
  await transport.fetch({ intentId: intent.intentId, agentRef, reservation: 'held' });
  await expect(page.transport('other').complete(result)).rejects.toThrow('identity mismatch');
  await expect(transport.complete({ ...result, operationDigest: memoryRevision('wrong') })).rejects.toThrow('identity mismatch');
  if (result.outcome !== 'applied') throw new Error('Expected applied');
  await expect(transport.complete({ ...result, result: { exists: true, revision: EMPTY_MEMORY_REVISION } })).rejects.toThrow('result mismatch');
  await transport.complete(completion(intent.intentId, 'uncertain'));
  expect(await transport.complete(result)).toMatchObject({ disposition: 'conflict', completion: { outcome: 'uncertain' } });
});

it.each(['revoke', 'expire', 'move'] as const)('withholds %s before release and purges the body', async reason => {
  const { intent } = await page.approve(approval());
  if (reason === 'revoke') page.revoke(intent.intentId);
  if (reason === 'expire') clock = 5000;
  if (reason === 'move') current = false;
  const response = await page.transport('device').fetch({ intentId: intent.intentId, agentRef, reservation: 'held' });
  expect(response).toMatchObject({ disposition: 'terminal', readback: { disposition: 'host_terminal', completion: { outcome: 'rejected' } } });
  expect(response).not.toHaveProperty('intent.content');
  expect(page.intent(intent.intentId)!.intent).not.toHaveProperty('content');
});

const retention = { acknowledgedIntentKeys: [], tombstoneRetentionMs: MIN_TOMBSTONE_RETENTION_MS };
async function settled(input: MemoryApproval) {
  const { intent } = await page.approve(input);
  const transport = page.transport('device');
  await transport.fetch({ intentId: intent.intentId, agentRef, reservation: 'held' });
  const result = completion(intent.intentId);
  await transport.complete(result);
  return { row: page.intent(intent.intentId)!, result };
}

it('compacts an acknowledged terminal row and replays it from the retired copy inside its window', async () => {
  const input = approval();
  const { row, result } = await settled(input);
  const pending = await page.approve(approval());
  const live = ledger.snapshot().memory!.intents[pending.intent.intentId];
  expect(ledger.compact({ ...retention, acknowledgedMemoryIntentIds: [row.intent.intentId], now: clock }))
    .toMatchObject({ memoryIntents: 1, alreadyCompactedMemoryIntents: 0 });
  expect(ledger.snapshot().memory!.intents).toEqual({ [pending.intent.intentId]: live });
  expect(Object.values(ledger.snapshot().memory!.approvals)).toEqual([pending.intent.intentId]);
  expect(page.intent(row.intent.intentId)).toBeUndefined();
  expect(JSON.stringify(ledger.retiredMemoryIntent('intent', row.intent.intentId, clock))).not.toContain('new text');
  ledger.close(); ledger = new HostLedger(path.join(root, 'ledger.sqlite'), 'product:host-core-test'); page = new HostMemoryPage(ledger, options());
  expect(await page.approve(input)).toEqual(row);
  await expect(page.approve({ ...input, content: 'changed' })).rejects.toThrow('identity conflict');
  const transport = page.transport('device');
  expect(await transport.fetch({ intentId: row.intent.intentId, agentRef, reservation: 'held' }))
    .toMatchObject({ disposition: 'terminal', readback: { completion: result } });
  expect(await transport.complete(result)).toMatchObject({ disposition: 'idempotent', completion: result });
  await expect(page.transport('other-device').complete(result)).rejects.toThrow('identity mismatch');
  expect(ledger.compact({ ...retention, acknowledgedMemoryIntentIds: [row.intent.intentId], now: clock }).alreadyCompactedMemoryIntents).toBe(1);
  expect(Object.keys(ledger.snapshot().memory!.intents)).toEqual([pending.intent.intentId]);
});

it('keeps a retired approval through its window and its own expiry, then admits the reference as new', async () => {
  const end = clock + MIN_TOMBSTONE_RETENTION_MS;
  const input = approval({ expiresAt: end + 1000 });
  const { row } = await settled(input);
  ledger.compact({ ...retention, acknowledgedMemoryIntentIds: [row.intent.intentId], now: clock });
  const renewed = { ...input, expiresAt: end + 5000 };
  clock = end + 500; // The window has ended, but the approval is still valid.
  expect(await page.approve(input)).toEqual(row);
  await expect(page.approve(renewed)).rejects.toThrow('identity conflict');
  clock = end + 1000;
  await expect(page.approve(input)).rejects.toThrow('expired');
  const fresh = await page.approve(renewed);
  expect(fresh.intent.approvalRef).toBe(input.approvalRef);
  expect(fresh.intent.intentId).not.toBe(row.intent.intentId);
  expect(ledger.compact({ ...retention, now: clock }).expiredTombstones).toBe(1);
  await expect(page.transport('device').fetch({ intentId: row.intent.intentId, agentRef, reservation: 'held' })).rejects.toThrow('identity mismatch');
});

it('refuses pending and unknown memory intents and rolls back the whole batch', async () => {
  const { row } = await settled(approval());
  const pending = await page.approve(approval());
  const before = ledger.snapshot();
  for (const [id, reason] of [[pending.intent.intentId, 'terminal'], ['missing', 'not found']] as const) {
    expect(() => ledger.compact({ ...retention, acknowledgedMemoryIntentIds: [row.intent.intentId, id], now: clock })).toThrow(reason);
    expect(ledger.snapshot()).toEqual(before);
    expect(ledger.retiredMemoryIntent('intent', row.intent.intentId, clock)).toBeUndefined();
  }
  expect(() => ledger.compact({ ...retention, acknowledgedMemoryIntentIds: row.intent.intentId as unknown as string[], now: clock })).toThrow('array');
});

it('retries an unconfirmed notice after restart with the exact same intent and no mailbox body', async () => {
  const { intent } = await page.approve(approval());
  notify.mockRejectedValueOnce(new Error('lost response'));
  await expect(page.flushNotices()).rejects.toMatchObject({ errors: [new Error('lost response')] });
  ledger.close(); ledger = new HostLedger(path.join(root, 'ledger.sqlite'), 'product:host-core-test'); page = new HostMemoryPage(ledger, options());
  await page.flushNotices(); await page.flushNotices();
  expect(notify.mock.calls).toEqual([[binding.deviceId, { intentId: intent.intentId, agentRef }], [binding.deviceId, { intentId: intent.intentId, agentRef }]]);
});

it('delivers later notices when an earlier transport fails and retains only the failed retry', async () => {
  const first = await page.approve(approval());
  const second = await page.approve(approval());
  notify.mockRejectedValueOnce(new Error('first delivery failed'));
  await expect(page.flushNotices()).rejects.toThrow();
  expect(notify.mock.calls).toHaveLength(2);
  expect(page.intent(first.intent.intentId)!.noticePending).toBe(true);
  expect(page.intent(second.intent.intentId)!.noticePending).toBe(false);
  await page.flushNotices();
  expect(notify.mock.calls).toHaveLength(3);
});

it('finishes a notice whose row settled and was compacted while the notice was in flight', async () => {
  const { intent } = await page.approve(approval());
  notify.mockImplementationOnce(async () => {
    const transport = page.transport('device');
    await transport.fetch({ intentId: intent.intentId, agentRef, reservation: 'held' });
    await transport.complete(completion(intent.intentId));
    ledger.compact({ ...retention, acknowledgedMemoryIntentIds: [intent.intentId], now: clock });
  });
  await page.flushNotices();
  expect(ledger.snapshot().memory!.intents).toEqual({});
  expect(ledger.retiredMemoryIntent('intent', intent.intentId, clock)?.readback).toBeDefined();
  await page.flushNotices();
  expect(notify).toHaveBeenCalledTimes(1);
});

it('checks projection hash, grant, exact profile, ordering and immutable mutation identity', async () => {
  const port = page.projectionPort('device');
  const first = projection('redacted resident');
  await expect(port.publish({ mutation: first })).resolves.toEqual({ accepted: true });
  const original = page.contextPack(binding);
  clock++;
  await port.publish({ mutation: first });
  expect(page.contextPack(binding)).toEqual(original);
  await expect(port.publish({ mutation: projection('other', { mutationId: first.mutationId }) })).rejects.toThrow('identity conflict');
  await expect(port.publish({ mutation: projection('stale') })).rejects.toThrow('Stale');
  await expect(port.publish({ mutation: projection('denied', { grantRef: 'other', sourceSeq: 2 }) })).rejects.toThrow('authorized');
  await expect(port.publish({ mutation: { ...first, snapshot: { ...first.snapshot, redactedHash: memoryRevision('bad') } } })).rejects.toThrow('hash mismatch');
  expect(page.contextPack({ ...binding, agentRef: { ...agentRef, profileRevision: '2' } })).toEqual({});
  await port.publish({ mutation: projection('next', { sourceSeq: 2 }) });
  expect(page.contextPack(binding).residentMemory!.text).toBe('next');
  await expect(port.publish({ mutation: projection('old epoch', { writerEpoch: 1, sourceSeq: 3, grantRef: 'other' }) })).rejects.toThrow();
});

it('allows absent memory, blocks oversized text and counts UTF-8 bytes', async () => {
  expect(page.contextPack(binding)).toEqual({});
  const port = page.projectionPort('device');
  await port.publish({ mutation: projection('é'.repeat(4096)) });
  expect(Buffer.byteLength(page.contextPack(binding).residentMemory!.text)).toBe(8192);
  await port.publish({ mutation: projection('é'.repeat(4096) + 'x', { sourceSeq: 2 }) });
  expect(() => page.contextPack(binding)).toThrow('exceeds 8 KiB');
  await port.publish({ mutation: projection(null, { sourceSeq: 3 }) });
  expect(page.contextPack(binding)).toEqual({});
  await port.publish({ mutation: projection('', { sourceSeq: 4 }) });
  expect(page.contextPack(binding).residentMemory!.text).toBe('');
});

it('blocks execution before submit, then freezes a resident ContextPack in the real offered instruction', async () => {
  let host: TestHost | undefined;
  try {
    host = await openHost({ memory: page });
    await page.projectionPort(host.deviceId).publish({ mutation: projection('x'.repeat(8193)) });
    const offer = await host.core.enqueue(host.intent('memory-turn'));
    expect(await host.server.tasks.offer(offer.taskId)).toBeUndefined();
    expect(host.core.intent('memory-turn')!.attempts).toBe(0);
    expect(Object.values(host.ledger.snapshot().outbox).some(row => row.lastError?.includes('Memory blocked'))).toBe(true);
    await page.projectionPort(host.deviceId).publish({ mutation: projection('resident [redacted]', { sourceSeq: 2 }) });
    await host.core.drain();
    const payload = (await host.server.tasks.offer(offer.taskId))!.payload;
    if (!('instruction' in payload)) throw new Error('Expected an inline instruction');
    const frozen = payload.instruction;
    expect(frozen).toContain('resident [redacted]');
    expect(frozen).toContain('ContextPack');
    await page.projectionPort(host.deviceId).publish({ mutation: projection('new projection', { sourceSeq: 3 }) });
    await host.core.drain();
    expect((await host.server.tasks.offer(offer.taskId))!.payload).toEqual(payload);
  } finally { await host?.close(); }
});


it('bootstraps without a resident projection', () => {
  expect(page.contextPack(binding)).toEqual({});
});

it('parks an oversized queue head without hot wake polling', async () => {
  const host = await openHost({ memory: page });
  try {
    await page.projectionPort(host.deviceId).publish({ mutation: projection('x'.repeat(8193)) });
    const wakes = vi.spyOn(host.server.wakes, 'schedule');
    await host.core.enqueue(host.intent('parked'));
    await new Promise(resolve => setTimeout(resolve, 2000));
    expect(host.core.intent('parked')).toMatchObject({ phase: 'memory_blocked', attempts: 0 });
    expect(wakes.mock.calls.length).toBeLessThanOrEqual(1);
  } finally { await host.close(); }
});


it('settles a blob instruction without attempts and starts the next inline intent', async () => {
  const host = await openHost({ memory: page, reconcileMs: 100 });
  try {
    const input = host.intent('blob-rejected');
    input.execution.payload.instruction = { blobRef: { blobId: 'blob', contentHash: memoryRevision('blob'), size: 4, contentType: 'text/plain' } };
    const rejected = await host.core.enqueue(input);
    expect(rejected).toMatchObject({ phase: 'settled', conclusion: 'failed', attempts: 0, generation: 0,
      preparationError: 'Memory ContextPack requires an inline instruction' });
    expect(rejected.memoryBlocked).toBeUndefined();
    expect(await host.server.tasks.offer(rejected.taskId)).toBeUndefined();
    const next = await host.core.enqueue(host.intent('inline-after-blob'));
    await vi.waitFor(() => expect(host.adapter.sessions.has(next.taskId)).toBe(true), { timeout: 5000 });
    await host.restartCore();
    expect(host.core.intent(input.key)).toEqual(rejected);
    const results: unknown[] = [];
    await host.core.flushProjections(async (_id, value) => { results.push(value); });
    expect(results).toContainEqual(expect.objectContaining({ intentKey: input.key, conclusion: 'failed',
      preparationError: rejected.preparationError }));
  } finally { await host.close(); }
});

it('settles a legacy blob block during startup recovery', async () => {
  const host = await openHost({ memory: page });
  try {
    await host.core.close();
    const input = host.intent('legacy-blob');
    input.execution.payload.instruction = { blobRef: { blobId: 'blob', contentHash: memoryRevision('blob'), size: 4, contentType: 'text/plain' } };
    host.ledger.transaction(state => {
      const row = enqueue(state, host.ledger.tenant, input);
      row.phase = 'memory_blocked';
      row.memoryBlocked = { resume: 'queued', reason: 'Memory ContextPack requires an inline instruction' };
    });
    await host.restartCore();
    expect(host.core.intent(input.key)).toMatchObject({ phase: 'settled', conclusion: 'failed', attempts: 0,
      preparationError: 'Memory ContextPack requires an inline instruction' });
    expect(host.core.intent(input.key)?.memoryBlocked).toBeUndefined();
    expect(await host.server.tasks.offer(host.core.intent(input.key)!.taskId)).toBeUndefined();
  } finally { await host.close(); }
});

it.each(['queued', 'memory_blocked'] as const)('starts profile rev2 behind a stale rev1 %s head', async initial => {
  let revision = '1';
  page = new HostMemoryPage(ledger, { ...options(), isCurrent: value => value.agentRef.profileRevision === revision });
  const host = await openHost({ memory: page, reconcileMs: 100 });
  try {
    const old = host.intent(`stale-profile-${initial}`);
    if (initial === 'memory_blocked') {
      await page.projectionPort(host.deviceId).publish({ mutation: projection('x'.repeat(8193)) });
      expect(await host.core.enqueue(old)).toMatchObject({ phase: 'memory_blocked', attempts: 0 });
    }
    revision = '2';
    if (initial === 'queued') await host.core.enqueue(old);
    const next = host.intent(`current-profile-${initial}`);
    next.execution.payload.agentRef.profileRevision = revision;
    const accepted = await host.core.enqueue(next);
    await vi.waitFor(() => expect(host.adapter.sessions.has(accepted.taskId)).toBe(true), { timeout: 5000 });
    expect(host.core.intent(old.key)).toMatchObject({ phase: 'settled', conclusion: 'failed', attempts: 0 });
    expect(host.core.intent(next.key)).toMatchObject({ phase: 'inflight', attempts: 1 });
    expect(await host.server.tasks.offer(host.core.intent(old.key)!.taskId)).toBeUndefined();
    const offer = await host.server.tasks.offer(accepted.taskId);
    expect(offer).toMatchObject({ payload: { agentRef: { profileRevision: '2' } } });
  } finally { await host.close(); }
});

it('keeps an unauthorized projection blocked until an authorized projection arrives', async () => {
  let authorized = true;
  page = new HostMemoryPage(ledger, { ...options(), authorizeProjection: () => authorized });
  const host = await openHost({ memory: page, reconcileMs: 100 });
  try {
    const port = page.projectionPort(host.deviceId);
    await port.publish({ mutation: projection('old authorized text') });
    authorized = false;
    const intent = await host.core.enqueue(host.intent('authorization-repair'));
    expect(intent).toMatchObject({ phase: 'memory_blocked', attempts: 0 });
    expect(await host.server.tasks.offer(intent.taskId)).toBeUndefined();
    authorized = true;
    await port.publish({ mutation: projection('authorized again', { sourceSeq: 2 }) });
    await vi.waitFor(() => expect(host.adapter.sessions.has(intent.taskId)).toBe(true), { timeout: 5000 });
    expect(host.core.intent(intent.key)).toMatchObject({ phase: 'inflight', attempts: 1 });
  } finally { await host.close(); }
});

it('restores a deadline wake when the projection reconciliation wake fails', async () => {
  const host = await openHost({ memory: page, reconcileMs: 100 });
  try {
    const port = page.projectionPort(host.deviceId);
    await port.publish({ mutation: projection('x'.repeat(8193)) });
    const intent = await host.core.enqueue(host.intent('refresh-wake-failure', { waitUntil: Date.now() + 2000 }));
    const wakes = vi.spyOn(host.server.wakes, 'schedule').mockRejectedValueOnce(new Error('schedule failed'));
    await expect(port.publish({ mutation: projection('repaired', { sourceSeq: 2 }) })).rejects.toThrow('Memory reconciliation wake failed');
    expect(await host.server.wakes.pending()).toEqual([expect.objectContaining({ availableAt: intent.waitUntil })]);
    expect(wakes).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(host.core.intent(intent.key)).toMatchObject({ phase: 'settled', conclusion: 'expired', attempts: 0 }), { timeout: 5000 });
    expect(host.adapter.sessions.has(intent.taskId)).toBe(false);
  } finally { await host.close(); }
});

it('bounds projection wake fallback failures and retains the deadline outbox for recovery', async () => {
  const host = await openHost({ memory: page, reconcileMs: 100 });
  try {
    const port = page.projectionPort(host.deviceId);
    await port.publish({ mutation: projection('x'.repeat(8193)) });
    const intent = await host.core.enqueue(host.intent('persistent-refresh-wake-failure'));
    const wakes = vi.spyOn(host.server.wakes, 'schedule')
      .mockRejectedValueOnce(new Error('initial failure')).mockRejectedValueOnce(new Error('fallback failure'));
    await expect(port.publish({ mutation: projection('repaired', { sourceSeq: 2 }) }))
      .rejects.toMatchObject({ errors: [new Error('initial failure'), new Error('fallback failure')] });
    expect(wakes).toHaveBeenCalledTimes(2);
    const scan = host.ledger.snapshot().scanWake!;
    expect(scan.availableAt).toBe(intent.waitUntil);
    expect(host.ledger.snapshot().outbox[`schedule:${scan.dedupKey}`]).toMatchObject({ kind: 'schedule', lastError: 'fallback failure' });
    expect(await host.server.wakes.pending()).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(wakes).toHaveBeenCalledTimes(2);
    await host.restartCore();
    await vi.waitFor(() => expect(host.adapter.sessions.has(intent.taskId)).toBe(true), { timeout: 5000 });
    expect(host.core.intent(intent.key)).toMatchObject({ phase: 'inflight', attempts: 1 });
  } finally { await host.close(); }
});

it('starts on duplicate publish after restoring a fallback deadline wake', async () => {
  const host = await openHost({ memory: page, reconcileMs: 100 });
  try {
    const port = page.projectionPort(host.deviceId);
    await port.publish({ mutation: projection('x'.repeat(8193)) });
    const intent = await host.core.enqueue(host.intent('wake-after-refresh'));
    const wakes = vi.spyOn(host.server.wakes, 'schedule').mockRejectedValueOnce(new Error('wake response lost'));
    const refreshed = projection('new resident', { sourceSeq: 2 });
    await expect(port.publish({ mutation: refreshed })).rejects.toThrow('Memory reconciliation wake failed');
    expect(host.core.intent(intent.key)).toMatchObject({ phase: 'queued', attempts: 0 });
    await port.publish({ mutation: refreshed });
    await vi.waitFor(() => expect(host.adapter.sessions.has(intent.taskId)).toBe(true), { timeout: 5000 });
    expect(host.core.intent(intent.key)).toMatchObject({ phase: 'inflight', attempts: 1 });
    const [failed, fallback, retry] = wakes.mock.calls.slice(0, 3).map(call => call[0]);
    expect(new Set([failed!.dedupKey, fallback!.dedupKey, retry!.dedupKey]).size).toBe(3);
    expect(fallback!.availableAt).toBe(intent.waitUntil);
    expect(retry!.availableAt).toBeLessThan(fallback!.availableAt);
  } finally { await host.close(); }
});


it('clears only an applied small replacement and waits for its refresh task projection', async () => {
  const port = page.projectionPort(binding.deviceId);
  const old = projection('x'.repeat(8193));
  await port.publish({ mutation: old });
  const conflict = await page.approve(approval());
  await page.transport(binding.deviceId).fetch({ intentId: conflict.intent.intentId, agentRef, reservation: 'held' });
  await page.transport(binding.deviceId).complete(completion(conflict.intent.intentId, 'conflict'));
  expect(() => page.contextPack(binding)).toThrow('exceeds 8 KiB');
  const applied = await page.approve(approval());
  await page.transport(binding.deviceId).fetch({ intentId: applied.intent.intentId, agentRef, reservation: 'held' });
  const result = completion(applied.intent.intentId);
  await page.transport(binding.deviceId).complete(result);
  expect(page.contextPack(binding)).toEqual({});
  await port.publish({ mutation: old });
  await port.publish({ mutation: projection('late old snapshot', { sourceSeq: 2 }) });
  expect(page.contextPack(binding)).toEqual({});
  page.refreshExecution(binding, 'refresh-task');
  await port.publish({ mutation: projection('fresh [redacted]', { taskId: 'refresh-task', sourceSeq: 3 }) });
  const fresh = page.contextPack(binding);
  expect(fresh.residentMemory?.text).toBe('fresh [redacted]');
  await page.transport(binding.deviceId).complete(result);
  expect(page.contextPack(binding)).toEqual(fresh);
});

it('recovers an accepted projection after the core was offline during its notification', async () => {
  const host = await openHost({ memory: page });
  try {
    const port = page.projectionPort(host.deviceId);
    await port.publish({ mutation: projection('x'.repeat(8193)) });
    const intent = await host.core.enqueue(host.intent('offline-refresh'));
    await host.core.close();
    await port.publish({ mutation: projection('fresh after restart', { sourceSeq: 2 }) });
    expect(host.core.intent(intent.key)).toMatchObject({ phase: 'memory_blocked', attempts: 0 });
    await host.restartCore();
    await vi.waitFor(() => expect(host.adapter.sessions.has(intent.taskId)).toBe(true), { timeout: 5000 });
    expect(host.core.intent(intent.key)).toMatchObject({ phase: 'inflight', attempts: 1 });
  } finally { await host.close(); }
});
