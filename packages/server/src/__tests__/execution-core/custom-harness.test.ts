import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { HostExecutionCore, type ExecutionServer } from '../../execution-core/core';
import { HostLedger } from '../../execution-core/ledger';
import { validateInput, type IntentInput, type ExecutionTemplate } from '../../execution-core/model';

function input(selection: Record<string, unknown>): IntentInput {
  return { key: 'message', source: 'user', waitUntil: 60_000, execution: { deviceId: 'device', payload: {
    ...selection, session: { mode: 'fresh' }, instruction: 'Return result', agentRef: { agentId: 'main', profileRevision: '1' },
    egressPolicy: { policyRevision: 'v1', activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 4096 },
      reliable: { maxPendingEventsPerAgent: 16, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 16384 },
      transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' } },
    terminalProjection: { mode: 'none' },
  } } as ExecutionTemplate };
}
it.each([{ runtime: 'pi' }, { runtime: 'claude' }, { runtime: 'codex' }, { harnessId: 'grok' }, { harnessId: 'acme.test-1' }])(
  'accepts one valid execution identity: %j', selection => expect(() => validateInput(input(selection))).not.toThrow());
it.each([{}, { runtime: 'grok' }, { runtime: '' }, { runtime: 1 }, { harnessId: '' }, { harnessId: 'Bad ID' },
  { harnessId: 'pi' }, { harnessId: 1 }, { harnessId: 'a'.repeat(129) }, { harnessId: null },
  { runtime: 'pi', harnessId: 'grok' }, { runtime: 'pi', harnessId: '' }, { runtime: 'pi', harnessId: null },
  { runtime: '', harnessId: 'grok' }, { runtime: null, harnessId: 'grok' }])(
  'rejects malformed or mixed execution identity: %j', selection => expect(() => validateInput(input(selection))).toThrow());

it.each([{ runtime: 'pi' }, { harnessId: 'grok' }])('preserves %j through enqueue, submit, settle and durable replay', async selection => {
  const root = mkdtempSync(join(tmpdir(), 'k4-identity-'));
  const filename = join(root, 'host.sqlite');
  let ledger = new HostLedger(filename, 'test');
  let terminal: unknown;
  const offers = new Map<string, any>();
  const submit = vi.fn(async (execution: any) => {
    offers.set(execution.taskId, { ...structuredClone(execution), type: 'task.offer', delivered: true });
  });
  const server = { executions: { submit }, tasks: {
    offer: async (id: string) => offers.get(id), deviceTerminal: async () => terminal,
    attempt: async (id: string) => ({ taskId: id, deviceId: 'device', agentRef: { agentId: 'main', profileRevision: '1' } }),
    cancel: vi.fn(),
  }, wakes: { schedule: vi.fn(), cancel: vi.fn(), pending: async () => [] } } as unknown as ExecutionServer;
  const applyOutcome = vi.fn();
  let core = new HostExecutionCore(server, ledger, { now: () => 1000, applyOutcome });
  try {
    const before = ledger.snapshot();
    await expect(core.enqueue(input({ runtime: 'pi', harnessId: 'grok' }))).rejects.toThrow();
    expect(ledger.snapshot()).toEqual(before);
    expect(submit).not.toHaveBeenCalled();
    const original = input(selection);
    await core.enqueue(original);
    await core.drain();
    const id = core.intent(original.key)!.taskId;
    expect(submit).toHaveBeenCalledTimes(1);
    expect(offers.get(id).payload).toEqual(original.execution.payload);
    await core.close(); ledger.close(); ledger = new HostLedger(filename, 'test');
    core = new HostExecutionCore(server, ledger, { now: () => 1000, applyOutcome });
    await core.recover();
    await core.enqueue(original);
    expect(submit).toHaveBeenCalledTimes(1);
    terminal = { envelope: { task_id: id, type: 'task.complete', payload: { document: { text: 'done' } } } };
    await core.drain();
    expect(core.intent(original.key)?.conclusion).toBe('succeeded');
    expect(applyOutcome).toHaveBeenCalledTimes(1);
    await core.close(); ledger.close(); ledger = new HostLedger(filename, 'test');
    core = new HostExecutionCore(server, ledger, { now: () => 1000, applyOutcome });
    await core.recover(); await core.enqueue(original); await core.drain();
    expect(core.intent(original.key)?.execution).toEqual(original.execution);
    expect(submit).toHaveBeenCalledTimes(1); expect(applyOutcome).toHaveBeenCalledTimes(1);
  } finally { await core.close(); ledger.close(); rmSync(root, { recursive: true, force: true }); }
});

it('accepts harness routines on create/update and refuses mixed replacements without mutation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'k4-routine-identity-'));
  const ledger = new HostLedger(join(root, 'host.sqlite'), 'test');
  const server = { wakes: { schedule: vi.fn(), cancel: vi.fn(), pending: async () => [] } } as unknown as ExecutionServer;
  const core = new HostExecutionCore(server, ledger, { now: () => 1000 });
  const routine = { id: 'routine', version: 1, timeZone: 'UTC', rule: { anchorMs: 2000, everyMs: 60_000 },
    waitMs: 60_000, lateAfterMs: 1000, execution: input({ harnessId: 'grok' }).execution };
  try {
    await core.addRoutine(routine);
    await core.updateRoutine({ ...routine, version: 2, execution: input({ runtime: 'pi' }).execution });
    await core.updateRoutine({ ...routine, version: 3 });
    expect(Object.values(ledger.snapshot().routines)[0]!.definition.execution!.payload.harnessId).toBe('grok');
    const before = ledger.snapshot();
    const invalid = input({ runtime: 'pi', harnessId: 'grok' }).execution;
    await expect(core.updateRoutine({ ...routine, version: 4, execution: invalid })).rejects.toThrow();
    await expect(core.addRoutine({ ...routine, id: 'invalid', execution: invalid })).rejects.toThrow();
    expect(ledger.snapshot()).toEqual(before);
  } finally { await core.close(); ledger.close(); rmSync(root, { recursive: true, force: true }); }
});
