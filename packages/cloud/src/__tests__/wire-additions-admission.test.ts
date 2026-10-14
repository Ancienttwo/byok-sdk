import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WIRE_ADDITIONS, isServerToDaemonType, requiredReceiverCapabilities, type MessageType } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { TENANT_A, createHarness, type CloudHarness } from './support/harness';

/**
 * #386: hosted admission reads `WIRE_ADDITIONS`, the table the protocol compat
 * suite proves against published decoders. For every server-to-daemon line of
 * the protocol corpus, a device missing any one flag the table requires is
 * refused before task or mailbox state, and a device with every flag is not
 * refused for a capability.
 */

type Enqueue = (harness: CloudHarness, deviceId: string, payload: never) => Promise<unknown>;

const ENQUEUE: Partial<Record<MessageType, Enqueue>> = {
  'task.offer': (h, d, payload) => h.cloud.enqueueOffer(TENANT_A, d, { taskId: 'gated', payload }),
  'task.offer_with_toolsets': (h, d, payload) => h.cloud.enqueueToolsetOffer(TENANT_A, d, { taskId: 'gated', payload }),
  'task.offer_for_agent': (h, d, payload) => h.cloud.enqueueAgentOffer(TENANT_A, d, { taskId: 'gated', payload }),
  'task.offer_for_agent_with_egress': (h, d, payload) => h.cloud.enqueueAgentEgressOffer(TENANT_A, d, { taskId: 'gated', payload }),
  'task.offer_for_agent_with_egress_fresh': (h, d, payload) =>
    h.cloud.enqueueFreshAgentEgressOffer(TENANT_A, d, { taskId: 'gated', payload }),
  'task.offer_prepared': (h, d, payload) => h.cloud.enqueuePreparedOffer(TENANT_A, d, { taskId: 'gated', payload }),
  'agent.content.read': (h, d, payload) => h.cloud.enqueueAgentContentRead(TENANT_A, d, { payload }),
  'agent.home.projection': (h, d, payload) => h.cloud.enqueueAgentHomeProjection(TENANT_A, d, payload),
  'agent.input.preparation': (h, d, payload) => h.cloud.enqueueInputPreparation(TENANT_A, d, payload),
  'provider.provisioning.available': (h, d, payload) => h.cloud.enqueueProviderProvisioningNotice(TENANT_A, d, payload),
  'agent.memory.intent.available': (h, d, payload) => h.cloud.enqueueAgentMemoryIntentNotice(TENANT_A, d, payload),
};

const corpusPath = fileURLToPath(new URL('../../../protocol/src/__tests__/golden/v2.envelopes.ndjson', import.meta.url));
const gatedLines = readFileSync(corpusPath, 'utf8')
  .split('\n')
  .filter((line) => line.length > 0)
  .map((line, index) => {
    const envelope = JSON.parse(line) as { type: MessageType; payload: Record<string, unknown> };
    return { line: index + 1, type: envelope.type, payload: envelope.payload, flags: requiredReceiverCapabilities(envelope.type, envelope.payload) };
  })
  .filter((entry) => isServerToDaemonType(entry.type) && entry.flags.length > 0);

async function deviceWith(capabilities: readonly string[]): Promise<{ harness: CloudHarness; deviceId: string }> {
  const harness = createHarness();
  const device = await harness.pairDevice(TENANT_A);
  await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, capabilities: [...capabilities] });
  return { harness, deviceId: device.deviceId };
}

async function errorCode(run: Promise<unknown>): Promise<string | undefined> {
  try {
    await run;
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
}

describe('hosted admission follows WIRE_ADDITIONS (#386)', () => {
  it('every device-advertised gated surface has a hosted enqueue path under test', () => {
    const surfaces = new Set(WIRE_ADDITIONS.flatMap((entry) =>
      entry.kind === 'envelope' && entry.rule === 'gated' && entry.advertisedBy === 'device' ? [entry.surface] : []));
    expect([...surfaces].filter((surface) => ENQUEUE[surface] === undefined)).toEqual([]);
    expect(new Set(gatedLines.map((entry) => entry.type))).toEqual(surfaces);
  });

  it.each(gatedLines.flatMap((entry) => entry.flags.map((flag) => [entry.line, entry.type, flag, entry] as const)))(
    'corpus line %i (%s) is refused without %s, before task or mailbox state',
    async (_line, type, flag, entry) => {
      const { harness, deviceId } = await deviceWith(entry.flags.filter((candidate) => candidate !== flag));

      await expect(ENQUEUE[type]!(harness, deviceId, entry.payload as never)).rejects.toMatchObject({
        code: 'agent_capability_missing',
        message: expect.stringContaining(flag),
      });
      expect(await harness.cloud.readTaskAttempt(TENANT_A, 'gated')).toBeUndefined();
      const page = await harness.core.mailbox.readAfter(TENANT_A, { deviceId, afterSeq: 0, limit: 10 });
      expect(page.messages).toEqual([]);
    },
  );

  it.each(gatedLines.map((entry) => [entry.line, entry.type, entry] as const))(
    'corpus line %i (%s) is not refused for a capability when the device advertises every flag the table requires',
    async (_line, type, entry) => {
      const { harness, deviceId } = await deviceWith(entry.flags);
      expect(await errorCode(ENQUEUE[type]!(harness, deviceId, entry.payload as never))).not.toBe('agent_capability_missing');
    },
  );
});
