import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FrozenOfferMismatchError, HostExecutionCore, HostLedger, submitFrozen, type ExecutionServer, type FrozenInput, type FrozenOffer, type FrozenSubmitPort } from '../../execution-core/index';

const input: FrozenInput = {
  taskId: 'task-1',
  deviceId: 'device-1',
  payload: {
    runtime: 'pi',
    session: { mode: 'fresh' },
    instruction: 'Reply to the room.',
    agentRef: { agentId: 'main', profileRevision: '1' },
    egressPolicy: {
      policyRevision: 'k4-v1', activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262144 },
      reliable: { maxPendingEventsPerAgent: 16, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 16384 },
      transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' },
    },
    terminalProjection: { mode: 'result-document', contract: 'k4-test-v1', schema: {
      type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string' } },
    } },
  },
};

function readback(delivered: boolean, change: Partial<FrozenOffer> = {}): FrozenOffer {
  return { taskId: input.taskId, deviceId: input.deviceId, messageId: 'message-1', type: 'task.offer',
    payload: structuredClone(input.payload), recordedAt: 1, delivered, ...change } as FrozenOffer;
}

/** `offers` holds the readbacks in call order; the last one repeats. */
function port(offers: (FrozenOffer | undefined)[], submit: FrozenSubmitPort['submit'] = async () => ({}) as never) {
  let read = 0;
  return { offer: vi.fn(async () => offers[Math.min(read++, offers.length - 1)]), submit: vi.fn(submit) };
}
const lost = async () => { throw new Error('lost response'); };
const open = () => true;

describe('submitFrozen (#793 D2b)', () => {
  it('submits once when no offer is recorded', async () => {
    const p = port([undefined]);
    expect(await submitFrozen(p, input, open)).toBe('delivered');
    expect(p.submit).toHaveBeenCalledTimes(1);
    expect(p.submit).toHaveBeenCalledWith(input);
  });

  it('does not submit a delivered offer, and does not ask beforeSubmit', async () => {
    const p = port([readback(true)]), beforeSubmit = vi.fn(open);
    expect(await submitFrozen(p, input, beforeSubmit)).toBe('delivered');
    expect(p.submit).not.toHaveBeenCalled();
    expect(beforeSubmit).not.toHaveBeenCalled();
  });

  it('submits a recorded offer that is not delivered, under the same task id', async () => {
    const p = port([readback(false)]);
    expect(await submitFrozen(p, input, open)).toBe('delivered');
    expect(p.submit).toHaveBeenCalledTimes(1);
    expect(p.submit.mock.calls[0]![0].taskId).toBe('task-1');
  });

  it('stops with no submit when beforeSubmit refuses an undelivered readback', async () => {
    const waitUntil = 1000, now = 1000;
    for (const offers of [[undefined], [readback(false)]]) {
      const p = port(offers);
      expect(await submitFrozen(p, input, () => now < waitUntil)).toBe('stopped');
      expect(p.submit).not.toHaveBeenCalled();
    }
  });

  it.each([
    ['taskId', { taskId: 'task-2' }],
    ['deviceId', { deviceId: 'device-2' }],
    ['type', { type: 'task.steer' }],
    ['payload', { payload: { ...structuredClone(input.payload), instruction: 'Another turn.' } }],
  ])('refuses a readback with another %s and never submits', async (_field, change) => {
    const p = port([readback(true, change as Partial<FrozenOffer>)]);
    const refused = submitFrozen(p, input, open);
    await expect(refused).rejects.toBeInstanceOf(FrozenOfferMismatchError);
    await expect(refused).rejects.toMatchObject({ code: 'frozen_offer_mismatch', message: 'Offer differs from the frozen input' });
    expect(p.submit).not.toHaveBeenCalled();
  });

  it('compares the payload by canonical bytes, not by key order', async () => {
    const reordered = Object.fromEntries(Object.entries(structuredClone(input.payload)).reverse());
    const p = port([readback(true, { payload: reordered } as Partial<FrozenOffer>)]);
    expect(await submitFrozen(p, input, open)).toBe('delivered');
    expect(p.submit).not.toHaveBeenCalled();
  });

  it('counts a throw as delivered only when the readback is delivered', async () => {
    const p = port([undefined, readback(true)], lost);
    expect(await submitFrozen(p, input, open)).toBe('delivered');
    expect(p.submit).toHaveBeenCalledTimes(1);
  });

  it.each([['an undelivered offer', readback(false)], ['no offer', undefined]])(
    'throws the submit error again after a throw with %s', async (_case, after) => {
      const p = port([undefined, after], lost);
      await expect(submitFrozen(p, input, open)).rejects.toThrow('lost response');
      expect(p.submit).toHaveBeenCalledTimes(1);
    });

  it('refuses a throw whose readback holds another offer', async () => {
    const p = port([undefined, readback(true, { deviceId: 'device-2' })], lost);
    await expect(submitFrozen(p, input, open)).rejects.toBeInstanceOf(FrozenOfferMismatchError);
    expect(p.submit).toHaveBeenCalledTimes(1);
  });
});

it('K4 never submits a begun intent whose readback is undelivered at waitUntil', async () => {
  const root = mkdtempSync(join(tmpdir(), 'k4-submit-expiry-'));
  const ledger = new HostLedger(join(root, 'host.sqlite'), 'test');
  let clock = 1000;
  const submit = vi.fn();
  // The readback is the last step before the submit decision. The clock passes waitUntil during it.
  const offer = vi.fn(async () => { clock = 60_000; return undefined; });
  const server = { executions: { submit }, tasks: { offer, deviceTerminal: async () => undefined, attempt: async () => undefined, cancel: vi.fn() },
    wakes: { schedule: vi.fn(), cancel: vi.fn(), pending: async () => [] } } as unknown as ExecutionServer;
  const core = new HostExecutionCore(server, ledger, { now: () => clock });
  try {
    await core.enqueue({ key: 'turn', source: 'user', waitUntil: 60_000, execution: { deviceId: input.deviceId, payload: input.payload } });
    expect(offer).toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(core.intent('turn')).toMatchObject({ cancelReason: 'expired', conclusion: 'expired' });
  } finally { await core.close(); ledger.close(); rmSync(root, { recursive: true, force: true }); }
});
