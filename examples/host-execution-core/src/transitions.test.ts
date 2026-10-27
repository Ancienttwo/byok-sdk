import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { agentKey, fifoHeads, hash, HostExecutionCore, HostLedger, queuedExpiry, type ExecutionServer, type IntentInput } from './index';

describe('queuedExpiry', () => {
  const open = { waitUntil: 100 };
  it.each([
    ['open', open, 50, undefined],
    ['at waitUntil', open, 100, 'expired'],
    ['at retryUntil, before waitUntil', { ...open, retryUntil: 60 }, 60, 'superseded'],
    ['past waitUntil and retryUntil', { ...open, retryUntil: 60 }, 100, 'expired'],
    ['cancelled while open', { ...open, cancelReason: 'cancelled' as const }, 50, 'cancelled'],
    ['cancelled past waitUntil', { ...open, cancelReason: 'cancelled' as const }, 100, 'cancelled'],
    ['marked expired before waitUntil', { ...open, cancelReason: 'expired' as const }, 50, 'superseded'],
  ])('%s', (_case, intent, now, conclusion) => expect(queuedExpiry(intent, now)).toBe(conclusion));
});

describe('fifoHeads', () => {
  it('keeps the lowest sequence of each agent, in first-seen agent order', () => {
    const rows = [{ id: 'b2', agent: 'b', sequence: 5 }, { id: 'a3', agent: 'a', sequence: 3 }, { id: 'b1', agent: 'b', sequence: 2 },
      { id: 'a1', agent: 'a', sequence: 1 }, { id: 'c9', agent: 'c', sequence: 9 }];
    expect(fifoHeads(rows).map(row => row.id)).toEqual(['b1', 'a1', 'c9']);
    expect(fifoHeads([])).toEqual([]);
  });
});

describe('agentKey', () => {
  it('is the hash of tenant, device and Agent id, and ignores the profile revision', () => {
    const execution = (profileRevision: string) => ({ deviceId: 'device', payload: { agentRef: { agentId: 'main', profileRevision } } });
    expect(agentKey('tenant', execution('1') as never)).toBe(hash(['tenant', 'device', 'main']));
    expect(agentKey('tenant', execution('2') as never)).toBe(agentKey('tenant', execution('1') as never));
    expect(agentKey('other', execution('1') as never)).not.toBe(agentKey('tenant', execution('1') as never));
  });
});

it('settles a cancelled intent in backoff before its retry time', async () => {
  const root = mkdtempSync(join(tmpdir(), 'k4-backoff-cancel-'));
  const ledger = new HostLedger(join(root, 'host.sqlite'), 'test');
  const agentRef = { agentId: 'main', profileRevision: '1' };
  const offers = new Map<string, unknown>();
  const submit = vi.fn(async (input: { taskId: string; deviceId: string; payload: unknown }) => {
    offers.set(input.taskId, { ...structuredClone(input), type: 'task.offer', delivered: true });
  });
  const server = { executions: { submit }, tasks: {
    offer: async (id: string) => offers.get(id),
    // Every attempt ends with a busy decline, so the intent goes to backoff.
    deviceTerminal: async (id: string) => offers.has(id) ? { envelope: { task_id: id, type: 'task.decline', payload: { code: 'agent_home_writer_busy' } } } : undefined,
    attempt: async (id: string) => offers.has(id) ? { taskId: id, deviceId: 'device', agentRef, status: 'declined' } : undefined,
    cancel: vi.fn(),
  }, wakes: { schedule: vi.fn(), cancel: vi.fn(), pending: async () => [] } } as unknown as ExecutionServer;
  const core = new HostExecutionCore(server, ledger, { now: () => 1000 });
  const input = { key: 'turn', source: 'user', waitUntil: 60_000, retry: { maxAttempts: 2, delaysMs: [10_000], retryFailures: false },
    execution: { deviceId: 'device', payload: { runtime: 'pi', session: { mode: 'fresh' }, instruction: 'Reply.', agentRef,
      egressPolicy: { policyRevision: 'v1', activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 4096 },
        reliable: { maxPendingEventsPerAgent: 16, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 16384 },
        transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' } },
      terminalProjection: { mode: 'none' } } } } as IntentInput;
  try {
    await core.enqueue(input);
    expect(core.intent('turn')).toMatchObject({ phase: 'backoff', notBefore: 11_000 });
    await core.cancel('turn');
    expect(core.intent('turn')).toMatchObject({ phase: 'settled', conclusion: 'cancelled' });
    expect(submit).toHaveBeenCalledTimes(1);
  } finally { await core.close(); ledger.close(); rmSync(root, { recursive: true, force: true }); }
});
