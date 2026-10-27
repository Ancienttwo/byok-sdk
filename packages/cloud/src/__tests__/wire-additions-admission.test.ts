import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WIRE_ADDITIONS, createEnvelope, isServerToDaemonType, requiredReceiverCapabilities, type MessageType } from '@byok-sdk/protocol';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { AgentExecutionInputSchema, SealedAgentExecutionInputSchema } from '../agent-execution';
import { handleInboundEnvelope } from '../inbound';
import { tenantStoresFor } from '../tenant-stores';
import { PRODUCT_ID, TENANT_A, TEST_AGENT_REF, createHarness, grantAgentHome, offerPayload, type CloudHarness } from './support/harness';

/**
 * #386: hosted admission reads `WIRE_ADDITIONS`, the table the protocol compat
 * suite checks as live v4 configuration gates. For every server-to-daemon line of
 * the active v4 protocol corpus, a device missing any one flag the table requires is
 * refused before task or mailbox state, and a device with every flag is not
 * refused for a capability.
 *
 * #470: fresh Agent offers have one hosted entry, `submitAgentExecution`. A
 * corpus line that entry cannot express is refused by its schema before any
 * device read; the closure case proves the expressible lines still exercise
 * every fresh-surface flag.
 */

type Enqueue = (harness: CloudHarness, deviceId: string, payload: never) => Promise<unknown>;

/**
 * #654: a steer goes only to a running task. This sets one up on another
 * task id, acknowledges its offer, and then steers it, so the checks below
 * still see no `gated` attempt and no pending mailbox row when the steer is
 * refused.
 */
async function steerSealedRunningTask(harness: CloudHarness, deviceId: string, payload: never): Promise<unknown> {
  await grantAgentHome(harness, TENANT_A, deviceId);
  const offer = await harness.cloud.enqueueAgentOffer(TENANT_A, deviceId, { taskId: 'steer-target', payload: offerPayload('steer me') });
  const stores = tenantStoresFor(
    { kind: 'device', tenantId: TENANT_A, productId: PRODUCT_ID, deviceId },
    { core: harness.core, cloud: harness.stores, mailboxWake: harness.mailboxWake },
  );
  for (const envelope of [
    createEnvelope('task.claim', { deviceId, agentRef: TEST_AGENT_REF, runtime: 'pi', capabilities: { steer: true } }, { taskId: offer.taskId }),
    createEnvelope('task.started', {}, { taskId: offer.taskId }),
  ]) {
    expect((await handleInboundEnvelope(stores, deviceId, envelope)).outcome).toBe('accepted');
  }
  await harness.core.mailbox.recordDelivery(TENANT_A, { deviceId, deliveredSeq: offer.seq });
  await harness.core.mailbox.advanceCursor(TENANT_A, { deviceId, ackedSeq: offer.seq });
  return harness.cloud.steerSealedTask(TENANT_A, offer.taskId, payload);
}

const FRESH = 'task.offer_for_agent_with_egress_fresh' satisfies MessageType;
const FRESH_SEALED = 'task.offer_for_agent_with_egress_fresh_sealed' satisfies MessageType;
/** Host input, not wire data: passed only when the payload selects `messageEgress`. */
const CONTEXT = { destinationBinding: 'conversation/386/turn/1' };

const submitFresh: Enqueue = (h, d, payload: { messageEgress?: unknown }) =>
  h.cloud.submitAgentExecution(TENANT_A, {
    taskId: 'gated',
    deviceId: d,
    payload: payload as never,
    ...(payload.messageEgress === undefined ? {} : { agentMessageContext: CONTEXT }),
  });

const ENQUEUE: Partial<Record<MessageType, Enqueue>> = {
  'task.offer_for_agent': (h, d, payload) => h.cloud.enqueueAgentOffer(TENANT_A, d, { taskId: 'gated', payload }),
  'task.offer_for_agent_with_egress': (h, d, payload) => h.cloud.enqueueAgentEgressOffer(TENANT_A, d, { taskId: 'gated', payload }),
  [FRESH]: submitFresh,
  'task.offer_prepared': (h, d, payload) => h.cloud.enqueuePreparedOffer(TENANT_A, d, { taskId: 'gated', payload }),
  'agent.content.read': (h, d, payload) => h.cloud.enqueueAgentContentRead(TENANT_A, d, { payload }),
  'agent.home.projection': (h, d, payload) => h.cloud.enqueueAgentHomeProjection(TENANT_A, d, payload),
  'agent.input.preparation': (h, d, payload) => h.cloud.enqueueInputPreparation(TENANT_A, d, payload),
  'provider.provisioning.available': (h, d, payload) => h.cloud.enqueueProviderProvisioningNotice(TENANT_A, d, payload),
  'agent.memory.intent.available': (h, d, payload) => h.cloud.enqueueAgentMemoryIntentNotice(TENANT_A, d, payload),
  'e2ee.key_package.available': (h, d, payload) => h.cloud.enqueueScopeKeyPackageNotice(TENANT_A, d, payload),
  // #654: each sealed type has its own hosted entry.
  'task.offer_for_agent_sealed': (h, d, payload) => h.cloud.enqueueSealedAgentOffer(TENANT_A, d, { taskId: 'gated', payload }),
  'task.offer_for_agent_with_egress_sealed': (h, d, payload) => h.cloud.enqueueSealedAgentEgressOffer(TENANT_A, d, { taskId: 'gated', payload }),
  [FRESH_SEALED]: (h, d, payload: { messageEgress?: unknown }) =>
    h.cloud.submitSealedAgentExecution(TENANT_A, {
      taskId: 'gated',
      deviceId: d,
      payload: payload as never,
      ...(payload.messageEgress === undefined ? {} : { agentMessageContext: CONTEXT }),
    }),
  'task.steer_sealed': steerSealedRunningTask,
};

const corpusPath = fileURLToPath(new URL('../../../protocol/src/__tests__/golden/v4.envelopes.ndjson', import.meta.url));
const gatedLines = readFileSync(corpusPath, 'utf8')
  .split('\n')
  .filter((line) => line.length > 0)
  .map((line, index) => {
    const envelope = JSON.parse(line) as { type: MessageType; payload: Record<string, unknown> };
    return { line: index + 1, type: envelope.type, payload: envelope.payload, flags: requiredReceiverCapabilities(envelope.type, envelope.payload) };
  })
  .filter((entry) => isServerToDaemonType(entry.type) && entry.flags.length > 0);

/** Whether the line's surface has a hosted entry that accepts its payload. */
const submitExpressible = (entry: (typeof gatedLines)[number]): boolean => {
  if (entry.type === FRESH) return AgentExecutionInputSchema.shape.payload.safeParse(entry.payload).success;
  // #654: the sealed fresh lane has the same rules in its own hosted entry.
  if (entry.type === FRESH_SEALED) return SealedAgentExecutionInputSchema.shape.payload.safeParse(entry.payload).success;
  return true;
};

async function deviceWith(capabilities: readonly string[]): Promise<{ harness: CloudHarness; deviceId: string }> {
  const harness = createHarness({ agentMessage: { consume: async () => ({ outcome: 'accepted' }) } });
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

/** The fresh payload schema's one refusal for a corpus line without `terminalProjection`. */
async function expectTerminalProjectionRequired(run: Promise<unknown>): Promise<void> {
  const error = await run.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ZodError);
  expect((error as ZodError).issues).toEqual([
    expect.objectContaining({ code: 'invalid_type', path: ['payload', 'terminalProjection'] }),
  ]);
}

describe('hosted admission follows WIRE_ADDITIONS (#386)', () => {
  it('every device-advertised gated surface has a hosted enqueue path under test', () => {
    const surfaces = new Set(WIRE_ADDITIONS.flatMap((entry) =>
      entry.kind === 'envelope' && entry.rule === 'gated' && entry.advertisedBy === 'device' ? [entry.surface] : []));
    expect([...surfaces].filter((surface) => ENQUEUE[surface] === undefined)).toEqual([]);
    expect(new Set(gatedLines.map((entry) => entry.type))).toEqual(surfaces);
  });

  it('every fresh-surface flag stays exercised through the hosted API', () => {
    const union = (entries: readonly (typeof gatedLines)[number][]) => new Set(entries.flatMap((entry) => entry.flags));
    const fresh = gatedLines.filter((entry) => entry.type === FRESH);
    const table = new Set(
      WIRE_ADDITIONS.flatMap((entry) => (entry.rule === 'gated' && entry.advertisedBy === 'device' && entry.surface === FRESH ? [entry.capability] : [])),
    );
    expect(union(fresh)).toEqual(table);
    expect(union(fresh.filter(submitExpressible))).toEqual(table);
    // The hosted entry requires an explicit terminal projection (#470), so the
    // fresh lines without one stay inexpressible rather than being reclassified.
    // HarnessId-only lines (no runtime) with a projection are expressible.
    const withoutProjection = fresh.filter((entry) => entry.payload.terminalProjection === undefined);
    expect(withoutProjection.length).toBeGreaterThan(0);
    expect(withoutProjection.filter(submitExpressible)).toEqual([]);
    const harnessOnly = fresh.filter((entry) => entry.payload.harnessId !== undefined && entry.payload.runtime === undefined);
    expect(harnessOnly.length).toBeGreaterThan(0);
    expect(harnessOnly.filter(submitExpressible)).toEqual(harnessOnly);
  });

  it.each(gatedLines.flatMap((entry) => entry.flags.map((flag) => [entry.line, entry.type, flag, entry] as const)))(
    'corpus line %i (%s) is refused without %s, before task or mailbox state',
    async (_line, type, flag, entry) => {
      const { harness, deviceId } = await deviceWith(entry.flags.filter((candidate) => candidate !== flag));
      const capabilityReads = vi.spyOn(harness.stores.devices, 'get');

      const run = ENQUEUE[type]!(harness, deviceId, entry.payload as never);
      if (submitExpressible(entry)) {
        await expect(run).rejects.toMatchObject({
          code: 'agent_capability_missing',
          message: expect.stringContaining(flag),
        });
      } else {
        await expectTerminalProjectionRequired(run);
        expect(capabilityReads).toHaveBeenCalledTimes(0);
      }
      expect(await harness.cloud.readTaskAttempt(TENANT_A, 'gated')).toBeUndefined();
      const page = await harness.core.mailbox.readAfter(TENANT_A, { deviceId, afterSeq: 0, limit: 10 });
      expect(page.messages).toEqual([]);
    },
  );

  it.each(gatedLines.map((entry) => [entry.line, entry.type, entry] as const))(
    'corpus line %i (%s) is not refused for a capability when the device advertises every flag the table requires',
    async (_line, type, entry) => {
      const { harness, deviceId } = await deviceWith(entry.flags);
      const run = ENQUEUE[type]!(harness, deviceId, entry.payload as never);
      if (submitExpressible(entry)) expect(await errorCode(run)).not.toBe('agent_capability_missing');
      else await expectTerminalProjectionRequired(run);
    },
  );
});
