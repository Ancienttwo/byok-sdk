import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { HostExecutionCore, HostLedger, type ExecutionServer, type Intent, type LedgerState } from '@byok-sdk/server/execution-core';
import { template } from './test-support';

// #957: `HostOptions.admitSubmit` holds a submit in `begin` and in the readback right before the SDK call.
let root: string | undefined, ledger: HostLedger | undefined, core: HostExecutionCore | undefined;
afterEach(async () => {
  await core?.close(); ledger?.close();
  if (root) rmSync(root, { recursive: true, force: true });
  root = ledger = core = undefined;
});
/** A server that records each submit; no task ever claims or ends, so a submitted intent stays in flight. */
function open(admitSubmit: (intent: Readonly<Intent>, state: Readonly<LedgerState>) => boolean) {
  root = mkdtempSync(join(tmpdir(), 'k4-submit-admission-'));
  ledger = new HostLedger(join(root, 'host.sqlite'), 'test');
  const submit = vi.fn(async (_input: { taskId: string }) => ({}));
  const server = { executions: { submit }, tasks: { offer: async () => undefined, deviceTerminal: async () => undefined, attempt: async () => undefined,
    cancel: vi.fn() }, wakes: { schedule: vi.fn(), cancel: vi.fn(), pending: async () => [] } } as unknown as ExecutionServer;
  core = new HostExecutionCore(server, ledger, { admitSubmit });
  return { submit, core };
}
const input = (key: string) => ({ key, source: 'user' as const, waitUntil: Date.now() + 600_000, execution: template('device') });
const execution = (key: string) => { const intent = core!.intent(key)!; return ledger!.snapshot().executions[intent.taskId]!; };

it('holds a queued intent with no submit and no new generation, and submits it once admitted', async () => {
  let admitted = false;
  const admit = vi.fn(() => admitted), { submit } = open(admit);
  await core!.enqueue(input('turn'));
  expect(admit).toHaveBeenCalledWith(expect.objectContaining({ key: 'turn' }), expect.objectContaining({ intents: expect.any(Object) }));
  expect(submit).not.toHaveBeenCalled();
  expect(core!.intent('turn')).toMatchObject({ phase: 'queued', generation: 0, attempts: 0 });
  await core!.drain();
  expect(submit).not.toHaveBeenCalled();
  // A held intent arms the scan only for its expiry, so the scan never re-arms at once while it stays held.
  expect(ledger!.snapshot().scanWake?.availableAt).toBe(core!.intent('turn')!.waitUntil);
  admitted = true;
  await core!.drain();
  expect(submit).toHaveBeenCalledTimes(1);
  expect(core!.intent('turn')).toMatchObject({ phase: 'inflight', attempts: 1 });
});

it('keeps a held backoff intent on its generation and task id, and starts the next generation once admitted', async () => {
  let admitted = true;
  const { submit } = open(() => admitted);
  await core!.enqueue(input('turn'));
  const first = core!.intent('turn')!;
  ledger!.transaction(state => { Object.assign(state.intents[first.id]!, { phase: 'backoff', notBefore: 0 }); });
  admitted = false;
  await core!.drain();
  expect(core!.intent('turn')).toMatchObject({ phase: 'backoff', generation: first.generation, taskId: first.taskId });
  expect(submit).toHaveBeenCalledTimes(1);
  admitted = true;
  await core!.drain();
  const next = core!.intent('turn')!;
  expect(next).toMatchObject({ phase: 'inflight', generation: first.generation + 1 });
  expect(submit).toHaveBeenCalledTimes(2);
  expect(submit.mock.calls[1]![0]).toMatchObject({ taskId: next.taskId });
});

it('does not send a begun intent when the readback refuses it, and sends the same task once admitted', async () => {
  // The first answer is the begin; the second is the readback right before the SDK call.
  const answers = [true, false];
  let later = false;
  const { submit } = open(() => answers.shift() ?? later);
  await core!.enqueue(input('turn'));
  expect(submit).not.toHaveBeenCalled();
  expect(core!.intent('turn')).toMatchObject({ phase: 'inflight', attempts: 1 });
  expect(execution('turn').submission).toBe('uncertain');
  const taskId = core!.intent('turn')!.taskId;
  await core!.drain();
  expect(submit).not.toHaveBeenCalled();
  later = true;
  await core!.drain();
  expect(submit).toHaveBeenCalledTimes(1);
  expect(submit.mock.calls[0]![0]).toMatchObject({ taskId });
});

it('settles a held intent on cancel with no submit', async () => {
  const { submit } = open(() => false);
  await core!.enqueue(input('turn'));
  await core!.cancel('turn');
  expect(core!.intent('turn')).toMatchObject({ conclusion: 'cancelled' });
  expect(submit).not.toHaveBeenCalled();
});

it('refuses an admission that is not a synchronous boolean', async () => {
  const { submit } = open(() => Promise.resolve(true) as never);
  await core!.enqueue(input('turn'));
  const intent = core!.intent('turn')!;
  expect(intent).toMatchObject({ phase: 'queued', attempts: 0 });
  expect(ledger!.snapshot().outbox[`intent:${intent.id}`]).toMatchObject({ lastError: 'Submit admission must return a boolean synchronously' });
  expect(submit).not.toHaveBeenCalled();
});
