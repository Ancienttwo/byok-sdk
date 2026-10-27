import { generateKeyPairSync } from 'node:crypto';
import { createInMemoryByokCloud, tenantId } from '@byok-sdk/cloud';
import { requiredReceiverCapabilities } from '@byok-sdk/protocol';
import { describe, expect, it, vi } from 'vitest';
import { FrozenOfferMismatchError, SealedDispatchUnavailableError, frozenOfferType, sameFrozenOffer, submitFrozen, type FrozenInput, type FrozenOffer,
  type FrozenSubmitPort, type SealedAgentExecutionInput } from './index';
import { sealRoutineTemplate, type RoutineRef } from './sealed-routine';
import { template as plainTemplate } from './test-support';

const egressPolicy = {
  policyRevision: 'k4-v1', activity: { delivery: 'latest-value' as const, maxCoalesceMs: 250, maxEventBytes: 262144 },
  reliable: { maxPendingEventsPerAgent: 16, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 16384 },
  transfers: { workspace: 'disabled' as const, transcript: 'disabled' as const, artifact: 'disabled' as const },
};
const terminalProjection = plainTemplate('device-1').payload.terminalProjection;
const agentRef = { agentId: 'main', profileRevision: '1' };
const sealing = { scopeId: 'scope-1', epoch: 2, categories: ['task-input' as const] };
const routineRef: RoutineRef = { routineId: 'routine-1', definitionVersion: 1, notAfter: '2026-12-31T00:00:00.000Z' };
const scopeKey = Uint8Array.from({ length: 32 }, (_, index) => index + 7);

function template(tenant: string, instruction = 'Check the watchlist.') {
  return sealRoutineTemplate({ tenantId: tenant, scopeKey, sealing, chainHead: { seq: 1, hash: `sha256:${'a'.repeat(64)}` }, sender: 'A'.repeat(43),
    routineRef, agentRef, instruction });
}
async function sealedInput(taskId: string, deviceId: string, tenant = 'tenant-k4'): Promise<SealedAgentExecutionInput> {
  return { taskId, deviceId, payload: { runtime: 'pi', session: { mode: 'fresh' }, agentRef, egressPolicy, terminalProjection, sealing, sealed: await template(tenant), routineRef } };
}
function plain(input: SealedAgentExecutionInput): FrozenInput {
  const { sealing: _, sealed: __, routineRef: ___, ...payload } = input.payload;
  return { ...input, payload: { ...payload, instruction: 'Check the watchlist.' } };
}
function readback(input: SealedAgentExecutionInput | FrozenInput, delivered: boolean, type = frozenOfferType()): FrozenOffer {
  return { taskId: input.taskId, deviceId: input.deviceId, messageId: 'message-1', type, payload: structuredClone(input.payload), recordedAt: '1',
    delivered } as FrozenOffer;
}

describe('a sealed frozen input (#953)', () => {
  it('reads back only the offer of its own lane', async () => {
    const sealed = await sealedInput('task-1', 'device-1'), open = plain(sealed);
    expect(frozenOfferType()).toBe('task.offer');
    expect(sameFrozenOffer(readback(sealed, true), sealed)).toBe(true);
    // A plain offer recorded for a sealed input, or the reverse, is never the frozen input.
    expect(sameFrozenOffer(readback(open, true), sealed)).toBe(false);
    expect(sameFrozenOffer(readback(sealed, true), open)).toBe(false);
    expect(sameFrozenOffer({ ...readback(sealed, true), payload: open.payload } as FrozenOffer, sealed)).toBe(false);
  });

  it('is a mismatch when the task holds another template', async () => {
    const sealed = await sealedInput('task-1', 'device-1'), other = { ...sealed, payload: { ...sealed.payload, sealed: await template('tenant-k4') } };
    expect(sameFrozenOffer(readback(other, true), sealed)).toBe(false);
    const port = { offer: vi.fn(async () => readback(other, false)), submit: vi.fn(), submitSealed: vi.fn() };
    await expect(submitFrozen(port, sealed, () => true)).rejects.toBeInstanceOf(FrozenOfferMismatchError);
    expect(port.submitSealed).not.toHaveBeenCalled();
  });

  it('goes to submitSealed, never to the plain submit', async () => {
    const sealed = await sealedInput('task-1', 'device-1');
    const port = { offer: vi.fn(async () => undefined), submit: vi.fn(), submitSealed: vi.fn(async () => ({}) as never) };
    expect(await submitFrozen(port, sealed, () => true)).toBe('delivered');
    expect(port.submitSealed).toHaveBeenCalledWith(sealed);
    expect(port.submit).not.toHaveBeenCalled();
  });

  it('calls submitSealed as a method of its port', async () => {
    const sealed = await sealedInput('task-1', 'device-1');
    const port = { sent: [] as SealedAgentExecutionInput[], offer: vi.fn(async () => undefined), submit: vi.fn(),
      async submitSealed(input: SealedAgentExecutionInput) { this.sent.push(input); return {} as never; } };
    expect(await submitFrozen(port, sealed, () => true)).toBe('delivered');
    expect(port.sent).toEqual([sealed]);
  });

  it('counts a delivered readback after a lost sealed submit', async () => {
    const sealed = await sealedInput('task-1', 'device-1');
    const offers = [undefined, readback(sealed, true)];
    let read = 0;
    const port = { offer: vi.fn(async () => offers[read++]), submit: vi.fn(), submitSealed: vi.fn(async () => { throw new Error('lost response'); }) };
    expect(await submitFrozen(port, sealed, () => true)).toBe('delivered');
    expect(port.submitSealed).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a port with no sealed lane: no readback, no beforeSubmit, no submit', async () => {
    const sealed = await sealedInput('task-1', 'device-1'), beforeSubmit = vi.fn(() => true);
    const port: FrozenSubmitPort = { offer: vi.fn(), submit: vi.fn() };
    const refused = submitFrozen(port, sealed, beforeSubmit);
    await expect(refused).rejects.toBeInstanceOf(SealedDispatchUnavailableError);
    await expect(refused).rejects.toMatchObject({ code: 'sealed_dispatch_unavailable' });
    expect(port.offer).not.toHaveBeenCalled();
    expect(beforeSubmit).not.toHaveBeenCalled();
    expect(port.submit).not.toHaveBeenCalled();
  });
});

describe('a sealed frozen input on the cloud (#953)', () => {
  async function sealedDevice() {
    const { cloud, core, stores } = createInMemoryByokCloud();
    const tenant = tenantId('tenant-k4');
    await core.quota.writeEntitlement(tenant, { version: 1n, hardLimitBytes: 1_000_000_000n, maxObjectBytes: 100_000_000n, maxInlineBytes: 1_000_000n,
      mailboxLimitBytes: 100_000_000n, retentionPolicyId: 'test' });
    const { code } = await cloud.createPairingCode(tenant, { productId: 'k4-sealed' });
    const publicKey = (generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as { x: string }).x;
    const paired = await cloud.fetch(new Request('http://cloud.test/byok/pair', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingCode: code, deviceName: 'k4-device', devicePublicKey: publicKey }) }));
    const { deviceId } = await paired.json() as { deviceId: string };
    const probe = await sealedInput('probe', deviceId);
    await stores.devices.recordCapabilities(tenant, { deviceId,
      capabilities: requiredReceiverCapabilities('task.offer', probe.payload as never) });
    const port: FrozenSubmitPort = {
      submit: input => cloud.submitAgentExecution(tenant, input),
      submitSealed: input => cloud.submitSealedAgentExecution(tenant, input),
      offer: taskId => cloud.readTaskOffer(tenant, taskId),
    };
    return { cloud, tenant, deviceId, port };
  }

  it('submits once, reads the same frozen bytes back, and a second occurrence reuses the template', async () => {
    const { cloud, tenant, deviceId, port } = await sealedDevice();
    const first = await sealedInput('occurrence-1', deviceId);
    const second = { ...first, taskId: 'occurrence-2' };
    const submitSealed = vi.spyOn(port, 'submitSealed');
    expect(await submitFrozen(port, first, () => true)).toBe('delivered');
    expect(await submitFrozen(port, second, () => true)).toBe('delivered');
    expect(submitSealed).toHaveBeenCalledTimes(2);
    for (const input of [first, second]) {
      const offer = await cloud.readTaskOffer(tenant, input.taskId);
      expect(offer?.type).toBe('task.offer');
      expect(sameFrozenOffer(offer!, input)).toBe(true);
      expect(offer!.payload).toMatchObject({ routineRef, sealed: first.payload.sealed });
    }
    // A delivered readback settles a resubmit with no second sealed submit.
    expect((await cloud.readTaskOffer(tenant, first.taskId))!.delivered).toBe(true);
    await expect(submitFrozen(port, first, () => true)).resolves.toBe('delivered');
    expect(submitSealed).toHaveBeenCalledTimes(2);
  });

  it('never resubmits a sealed task as plain: the readback is a mismatch', async () => {
    const { port, deviceId } = await sealedDevice();
    const sealed = await sealedInput('occurrence-1', deviceId);
    expect(await submitFrozen(port, sealed, () => true)).toBe('delivered');
    await expect(submitFrozen(port, plain(sealed), () => true)).rejects.toBeInstanceOf(FrozenOfferMismatchError);
  });
});
