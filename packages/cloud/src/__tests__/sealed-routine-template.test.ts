/**
 * #654 E3d: the Host side of a sealed routine occurrence.
 *
 * The sealed execution lane takes the offer's plaintext `routineRef` through
 * the protocol schema, and stores the template as the offer's sealed member.
 * The comparison projection of a duplicate offer (§9.2) keeps `routineRef` and
 * the template's content MAC, so another reference or another template under
 * the same task id is a conflict. The Host does not check `notAfter`: the
 * device does, against its own clock.
 */
import { decodeEnvelope, requiredReceiverCapabilities, type MessageType } from '@byok-sdk/protocol';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { TENANT_A, createHarness, type CloudHarness, type PairedDevice } from './support/harness';
import { SEALING, inlineMember, sealTemplate } from './support/sealed';

type RoutineRef = { routineId: string; definitionVersion: number; notAfter: string };
type Payload = Record<string, unknown> & { routineRef: RoutineRef; agentRef: { agentId: string; profileRevision: string }; sealed: object };

const TYPE = 'task.offer';
const CONTEXT = { destinationBinding: 'conversation/654/routine/1' };
const routineLines = readFileSync(new URL('../../../protocol/src/__tests__/golden/v5.envelopes.ndjson', import.meta.url), 'utf8')
  .trimEnd()
  .split('\n')
  .map((raw) => JSON.parse(raw) as { type: MessageType; ts: string; payload: Payload })
  .filter((line) => line.payload.routineRef !== undefined);
const occurrence = () => structuredClone(routineLines[0]!.payload);

async function routineDevice(): Promise<{ harness: CloudHarness; device: PairedDevice }> {
  const harness = createHarness({ agentMessage: { consume: async () => ({ outcome: 'accepted' }) } });
  const device = await harness.pairDevice(TENANT_A);
  await harness.stores.devices.recordCapabilities(TENANT_A, {
    deviceId: device.deviceId, capabilities: requiredReceiverCapabilities(TYPE, occurrence() as never),
  });
  return { harness, device };
}

function submit(harness: CloudHarness, device: PairedDevice, taskId: string, payload: Payload) {
  return harness.cloud.submitSealedAgentExecution(TENANT_A, { taskId, deviceId: device.deviceId, payload: payload as never, agentMessageContext: CONTEXT });
}

async function mailbox(harness: CloudHarness, device: PairedDevice) {
  const page = await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0, limit: 10 });
  return page.messages.map((message) => decodeEnvelope(message.body));
}

/** The first offer fails at its mailbox append, after its receipt. Only then may the same task id be offered again. */
async function failedFirst(harness: CloudHarness, device: PairedDevice, taskId: string, payload: Payload): Promise<void> {
  vi.spyOn(harness.core.mailbox, 'append').mockRejectedValueOnce(new Error('mailbox unavailable'));
  await expect(submit(harness, device, taskId, payload)).rejects.toThrow('mailbox unavailable');
  expect(await mailbox(harness, device)).toEqual([]);
}

function template(payload: Payload, routineRef: RoutineRef, instruction: string) {
  return sealTemplate({ tenant: TENANT_A, routineRef, agentRef: payload.agentRef, plaintext: { instruction } });
}

describe('a sealed routine occurrence on the Host (#654 E3d)', () => {
  it('the corpus template is sealed under the corpus scope', () => {
    expect(occurrence().sealing).toEqual(SEALING);
  });

  it('enqueues routineRef and the template as given, and a second occurrence reuses the same template', async () => {
    const { harness, device } = await routineDevice();
    const first = await submit(harness, device, 'routine-occurrence-1', occurrence());
    const second = await submit(harness, device, 'routine-occurrence-2', occurrence());
    expect(first.envelope.payload).toEqual(occurrence());
    expect(second.envelope.payload).toEqual(occurrence());
    expect(await mailbox(harness, device)).toEqual([first.envelope, second.envelope]);
  });

  it('accepts a template whose notAfter has passed: the device checks it', async () => {
    const { harness, device } = await routineDevice();
    const expired = routineLines.find((line) => Date.parse(line.payload.routineRef.notAfter) < Date.parse(line.ts))!;
    const enqueued = await submit(harness, device, 'routine-expired', structuredClone(expired.payload));
    expect(enqueued.envelope.payload).toEqual(expired.payload);
  });

  it('keeps the first template when a retry seals the same template again', async () => {
    const { harness, device } = await routineDevice();
    const payload = occurrence();
    const first = await template(payload, payload.routineRef, 'Write the daily digest.');
    const again = await template(payload, payload.routineRef, 'Write the daily digest.');
    expect(again.header.salt).not.toBe(first.header.salt);
    await failedFirst(harness, device, 'routine-retry', { ...payload, sealed: inlineMember(first) });
    const retried = await submit(harness, device, 'routine-retry', { ...payload, sealed: inlineMember(again) });
    expect(retried.envelope.payload).toMatchObject({ sealed: inlineMember(first) });
    expect(await mailbox(harness, device)).toEqual([retried.envelope]);
  });

  const conflicts: readonly (readonly [string, (payload: Payload) => Promise<Payload>])[] = [
    ['another definitionVersion', async (payload) => ({ ...payload, routineRef: { ...payload.routineRef, definitionVersion: payload.routineRef.definitionVersion + 1 } })],
    ['another routine', async (payload) => ({ ...payload, routineRef: { ...payload.routineRef, routineId: 'routine-other' } })],
    ['another notAfter', async (payload) => ({ ...payload, routineRef: { ...payload.routineRef, notAfter: '2027-01-31T00:00:00.000Z' } })],
    ['no routineRef', async ({ routineRef: _routineRef, ...payload }) => payload as Payload],
    ['another template under the same routineRef', async (payload) => ({ ...payload, sealed: inlineMember(await template(payload, payload.routineRef, 'Delete the archive.')) })],
  ];

  it.each(conflicts)('refuses %s under the same task id, and keeps the first offer', async (_name, change) => {
    const { harness, device } = await routineDevice();
    const payload = occurrence();
    await failedFirst(harness, device, 'routine-conflict', payload);
    await expect(submit(harness, device, 'routine-conflict', await change(occurrence()))).rejects.toMatchObject({ code: 'coordination_input_invalid' });
    expect(await mailbox(harness, device)).toEqual([]);
    const retried = await submit(harness, device, 'routine-conflict', payload);
    expect(retried.envelope.payload).toEqual(payload);
    expect(await mailbox(harness, device)).toEqual([retried.envelope]);
  });
});
