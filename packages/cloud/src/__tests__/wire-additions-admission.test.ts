import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { INPUT_IMAGES_CAPABILITY, SKILL_SELECTION_CAPABILITY, WIRE_ADDITIONS, ExecutionTargetSchema, createEnvelope, isServerToDaemonType, requiredReceiverCapabilities, type HarnessInfo, type MessageType, type TaskSteerSealedPayload } from '@byok-sdk/protocol';
import { describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import { AgentExecutionInputSchema, SealedAgentExecutionInputSchema, type AgentExecutionInput } from '../agent-execution';
import type { ByokCloud } from '../cloud';
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
 * every flag a fresh execution can need.
 *
 * #925: every offer is a `task.offer`, so a corpus line takes the hosted lane
 * its payload selects (`offerVariantOf`), one per old offer type. A sealed
 * resume offer has no hosted lane, so its corpus lines are out of scope here.
 */

type Enqueue = (harness: CloudHarness, deviceId: string, payload: never) => Promise<unknown>;

/**
 * #654: a steer goes only to a running task. This sets one up on another
 * task id, acknowledges its offer, and then steers it, so the checks below
 * still see no `gated` attempt and no pending mailbox row when the steer is
 * refused.
 */
type HostedSteerPayload = Parameters<ByokCloud['steerTask']>[2] | TaskSteerSealedPayload;

async function steerRunningTask(harness: CloudHarness, deviceId: string, payload: HostedSteerPayload): Promise<unknown> {
  await grantAgentHome(harness, TENANT_A, deviceId);
  const offer = await harness.cloud.enqueueAgentOffer(TENANT_A, deviceId, { taskId: 'steer-target', payload: offerPayload('steer me') });
  const stores = tenantStoresFor(
    { kind: 'device', tenantId: TENANT_A, productId: PRODUCT_ID, deviceId },
    { core: harness.core, cloud: harness.stores, mailboxWake: harness.mailboxWake },
  );
  for (const envelope of [
    createEnvelope('task.claim', { deviceId, agentRef: TEST_AGENT_REF, executor: { id: 'pi' }, capabilities: { steer: true } }, { taskId: offer.taskId }),
    createEnvelope('task.started', {}, { taskId: offer.taskId }),
  ]) {
    expect((await handleInboundEnvelope(stores, deviceId, envelope)).outcome).toBe('accepted');
  }
  await harness.core.mailbox.recordDelivery(TENANT_A, { deviceId, deliveredSeq: offer.seq });
  await harness.core.mailbox.advanceCursor(TENANT_A, { deviceId, ackedSeq: offer.seq });
  return 'sealed' in payload
    ? harness.cloud.steerSealedTask(TENANT_A, offer.taskId, payload)
    : harness.cloud.steerTask(TENANT_A, offer.taskId, payload);
}

type OfferVariant = 'resume' | 'resume with egress' | 'fresh execution' | 'prepared' | 'sealed execution';

/**
 * The hosted lane that sends a `task.offer` payload: every lane sends the one
 * type, so the payload picks the lane. `undefined` for a sealed resume offer.
 */
function offerVariantOf(payload: Record<string, unknown>): OfferVariant | undefined {
  const fresh = (payload.session as { mode?: unknown } | undefined)?.mode === 'fresh';
  if (payload.sealing !== undefined) return fresh ? 'sealed execution' : undefined;
  if (payload.preparation !== undefined) return 'prepared';
  if (fresh) return 'fresh execution';
  return payload.egressPolicy === undefined ? 'resume' : 'resume with egress';
}

/** Host input, not wire data: passed only when the payload selects `messageEgress`. */
const CONTEXT = { destinationBinding: 'conversation/386/turn/1' };

const submitFresh: Enqueue = (h, d, payload: { messageEgress?: unknown }) =>
  h.cloud.submitAgentExecution(TENANT_A, {
    taskId: 'gated',
    deviceId: d,
    payload: payload as never,
    ...(payload.messageEgress === undefined ? {} : { agentMessageContext: CONTEXT }),
  });

const submitSealedFresh: Enqueue = (h, d, payload: { messageEgress?: unknown }) =>
  h.cloud.submitSealedAgentExecution(TENANT_A, {
    taskId: 'gated',
    deviceId: d,
    payload: payload as never,
    ...(payload.messageEgress === undefined ? {} : { agentMessageContext: CONTEXT }),
  });

const OFFER_ENQUEUE: Record<OfferVariant, Enqueue> = {
  resume: (h, d, payload) => h.cloud.enqueueAgentOffer(TENANT_A, d, { taskId: 'gated', payload }),
  'resume with egress': (h, d, payload) => h.cloud.enqueueAgentEgressOffer(TENANT_A, d, { taskId: 'gated', payload }),
  'fresh execution': submitFresh,
  prepared: (h, d, payload) => h.cloud.enqueuePreparedOffer(TENANT_A, d, { taskId: 'gated', payload }),
  'sealed execution': submitSealedFresh,
};

const ENQUEUE: Partial<Record<MessageType, Enqueue>> = {
  'task.offer': (h, d, payload) => OFFER_ENQUEUE[offerVariantOf(payload as Record<string, unknown>)!](h, d, payload),
  'agent.content.read': (h, d, payload) => h.cloud.enqueueAgentContentRead(TENANT_A, d, { payload }),
  'agent.home.projection': (h, d, payload) => h.cloud.enqueueAgentHomeProjection(TENANT_A, d, payload),
  'agent.input.preparation': (h, d, payload) => h.cloud.enqueueInputPreparation(TENANT_A, d, payload),
  'agent.memory.intent.available': (h, d, payload) => h.cloud.enqueueAgentMemoryIntentNotice(TENANT_A, d, payload),
  'e2ee.key_package.available': (h, d, payload) => h.cloud.enqueueScopeKeyPackageNotice(TENANT_A, d, payload),
  'task.steer': steerRunningTask,
};

/**
 * The cloud emits a message disposition itself, after it admits the device's
 * publish; no Host enqueues one. It carries `contentMac` only for a sealed
 * message, which the inbound path admits only on a task whose offer sealed
 * `agent-message`, and that offer was gated on the device flag (#1045 S3).
 */
const CLOUD_EMITTED: readonly MessageType[] = ['agent.message.disposition'];

/** A gated server-to-daemon type this cloud has no Host enqueue for. */
const NOT_HOSTED: readonly MessageType[] = ['provider.provisioning.available'];

const corpusPath = fileURLToPath(new URL('../../../protocol/src/__tests__/golden/v8.envelopes.ndjson', import.meta.url));
const gatedLines = readFileSync(corpusPath, 'utf8')
  .split('\n')
  .filter((line) => line.length > 0)
  .map((line, index) => {
    const envelope = JSON.parse(line) as { type: MessageType; payload: Record<string, unknown> };
    return {
      line: index + 1,
      type: envelope.type,
      payload: envelope.payload,
      variant: envelope.type === 'task.offer' ? offerVariantOf(envelope.payload) : undefined,
      flags: requiredReceiverCapabilities(envelope.type, envelope.payload),
    };
  })
  .filter((entry) => isServerToDaemonType(entry.type) && entry.flags.length > 0 && !CLOUD_EMITTED.includes(entry.type)
    && !NOT_HOSTED.includes(entry.type) && !(entry.type === 'task.offer' && entry.variant === undefined));

const freshBase = {
  ...offerPayload(),
  session: { mode: 'fresh' },
  terminalProjection: { mode: 'none' },
  egressPolicy: {
    policyRevision: 'policy-r1',
    activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262144 },
    reliable: { maxPendingEventsPerAgent: 16, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 8192 },
    transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' },
  },
} satisfies AgentExecutionInput['payload'];

/** The wire corpus exercises these fields on resume offers. Give them fresh Host inputs too. */
const hostedFresh = [
  { field: 'images', flag: INPUT_IMAGES_CAPABILITY, fields: { images: [{
    mediaType: 'image/png',
    blob: { blobId: 'fresh-image', contentHash: `sha256:${'a'.repeat(64)}`, size: 32, contentType: 'image/png' },
  }] } },
  { field: 'requiredSkills', flag: SKILL_SELECTION_CAPABILITY, fields: { requiredSkills: ['review'] } },
] satisfies { field: string; flag: string; fields: Partial<AgentExecutionInput['payload']> }[];

const hostedFreshCases = hostedFresh.map(({ field, flag, fields }) => {
  const payload = { ...freshBase, ...fields };
  return { field, flag, payload, variant: 'fresh execution' as const, flags: requiredReceiverCapabilities('task.offer', payload) };
});

/** Keep every corpus row's gates exercised with valid Host selections (#1671). */
function hostCopy(entry: (typeof gatedLines)[number]) {
  if (entry.type !== 'task.offer') return entry;
  const payload = { ...entry.payload };
  if (payload.homeAccess === 'memory-reader' && payload.agentMemory === 'read-write') payload.agentMemory = 'read';
  return { ...entry, payload };
}

/** Only fresh execution's terminalProjection requirement excludes corpus rows from gate checks. */
const submitExpressible = (entry: Pick<(typeof gatedLines)[number], 'variant' | 'payload'>): boolean => {
  if (entry.variant === 'fresh execution') return AgentExecutionInputSchema.shape.payload.safeParse(entry.payload).success;
  if (entry.variant === 'sealed execution') return SealedAgentExecutionInputSchema.shape.payload.safeParse(entry.payload).success;
  return true;
};

function harnessTargetOf(payload: Record<string, unknown> | undefined) {
  const target = ExecutionTargetSchema.safeParse(payload?.target);
  return target.success && target.data.lane === 'harness' ? target.data : undefined;
}

async function deviceWith(capabilities: readonly string[], payload?: Record<string, unknown>): Promise<{ harness: CloudHarness; deviceId: string }> {
  const harness = createHarness({ agentMessage: { consume: async () => ({ outcome: 'accepted' }) } });
  const device = await harness.pairDevice(TENANT_A);
  const target = harnessTargetOf(payload);
  const harnesses: HarnessInfo[] = [{ id: 'pi', capabilities: { selectionModes: ['device-default'], effort: false } }];
  if (target !== undefined) {
    const { harnessId, selection } = target;
    const capabilities: HarnessInfo['capabilities'] = {
      selectionModes: [selection.mode], effort: target.effort !== undefined,
      ...(target.serviceTier === undefined ? {} : { serviceTier: true }),
      ...(target.serviceTierFallback === undefined ? {} : { serviceTierFallback: true }),
      ...(selection.mode === 'byok' ? { byokProviderId: selection.providerId } : {}),
    };
    const executor = { id: harnessId, capabilities };
    if (harnessId === 'pi') harnesses[0] = executor;
    else harnesses.push(executor);
  }
  await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId: device.deviceId, capabilities, harnesses });
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

/** The fresh payload schema's pinned refusal for a corpus line without terminalProjection. */
async function expectTerminalProjectionRequired(run: Promise<unknown>): Promise<void> {
  const error = await run.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ZodError);
  expect((error as ZodError).issues.map(({ code, path }) => ({ code, path }))).toEqual([
    { code: 'invalid_type', path: ['payload', 'terminalProjection'] },
  ]);
}

describe('hosted admission follows WIRE_ADDITIONS (#386)', () => {
  it('every device-advertised gated surface has a hosted enqueue path under test', () => {
    const surfaces = new Set(WIRE_ADDITIONS.flatMap((entry) =>
      !CLOUD_EMITTED.includes(entry.surface) && !NOT_HOSTED.includes(entry.surface) ? [entry.surface] : []));
    expect([...surfaces].filter((surface) => ENQUEUE[surface] === undefined)).toEqual([]);
    expect(new Set(gatedLines.map((entry) => entry.type))).toEqual(surfaces);
  });

  it('every fresh-execution flag stays exercised through the hosted API', () => {
    const union = (entries: readonly Pick<(typeof gatedLines)[number], 'flags'>[]) => new Set(entries.flatMap((entry) => entry.flags));
    const fresh = [...gatedLines.filter((entry) => entry.variant === 'fresh execution'), ...hostedFreshCases];
    const table = new Set(
      WIRE_ADDITIONS.flatMap((entry) => (
        entry.surface === 'task.offer'
          && entry.field !== 'preparation' && entry.field !== 'sealing' && entry.field !== 'sealing.categories' ? [entry.capability] : [])),
    );
    expect(union(fresh)).toEqual(table);
    expect(union(fresh.filter(submitExpressible))).toEqual(table);
    // The hosted entry requires an explicit terminal projection (#470), so the
    // fresh lines without one stay inexpressible rather than being reclassified.
    // Harness-target lines with a projection are expressible.
    const withoutProjection = fresh.filter((entry) => entry.payload.terminalProjection === undefined);
    expect(withoutProjection.length).toBeGreaterThan(0);
    expect(withoutProjection.filter(submitExpressible)).toEqual([]);
    const harnessOnly = fresh.filter((entry) => entry.payload.terminalProjection !== undefined && harnessTargetOf(entry.payload) !== undefined);
    expect(harnessOnly.length).toBeGreaterThan(0);
    expect(harnessOnly.filter(submitExpressible)).toEqual(harnessOnly);
  });

  it.each(hostedFreshCases)('gates fresh execution $field and preserves it in the admitted offer', async ({ flag, flags, payload }) => {
    const { harness, deviceId } = await deviceWith(flags.filter((candidate) => candidate !== flag), payload);
    const submit = () => harness.cloud.submitAgentExecution(TENANT_A, { taskId: 'gated', deviceId, payload });

    await expect(submit()).rejects.toMatchObject({
      code: 'agent_capability_missing',
      message: expect.stringContaining(flag),
    });
    expect(await harness.cloud.readTaskAttempt(TENANT_A, 'gated')).toBeUndefined();
    expect((await harness.core.mailbox.readAfter(TENANT_A, { deviceId, afterSeq: 0 })).messages).toEqual([]);

    const advertised = await harness.stores.devices.get(TENANT_A, deviceId);
    await harness.stores.devices.recordCapabilities(TENANT_A, { deviceId, capabilities: flags, harnesses: advertised?.harnesses });
    await expect(submit()).resolves.toMatchObject({ envelope: { type: 'task.offer', payload } });
  });

  it.each(gatedLines.filter(entry => entry.payload.homeAccess === 'memory-reader' && entry.payload.agentMemory === 'read-write'))(
    'raw corpus offer $line has its pinned reader-rule refusal before device reads', async entry => {
      const { harness, deviceId } = await deviceWith(entry.flags);
      const reads = vi.spyOn(harness.stores.devices, 'get');
      const error = await ENQUEUE[entry.type]!(harness, deviceId, entry.payload as never)
        .then(() => undefined, (caught: unknown) => caught);
      expect(error).toBeInstanceOf(ZodError);
      expect((error as ZodError).issues.map(({ code, path }) => ({ code, path }))).toEqual([{ code: 'custom', path: ['agentMemory'] }]);
      expect(reads).not.toHaveBeenCalled();
      expect(await harness.cloud.readTaskAttempt(TENANT_A, 'gated')).toBeUndefined();
      expect((await harness.core.mailbox.readAfter(TENANT_A, { deviceId, afterSeq: 0 })).messages).toEqual([]);
    },
  );

  it.each(Object.keys(OFFER_ENQUEUE) as OfferVariant[])('preserves every corpus capability gate on the %s lane', variant => {
    const entries = gatedLines.filter(entry => entry.variant === variant);
    const host = entries.map(hostCopy).filter(submitExpressible);
    expect(new Set(host.flatMap(entry => entry.flags))).toEqual(new Set(entries.flatMap(entry => entry.flags)));
    for (const entry of host) expect(requiredReceiverCapabilities(entry.type, entry.payload)).toEqual(entry.flags);
  });

  it.each(gatedLines.flatMap((entry) => entry.flags.map((flag) => [entry.line, entry.variant ?? entry.type, flag, entry] as const)))(
    'corpus line %i (%s) is refused without %s, before task or mailbox state',
    async (_line, _label, flag, entry) => {
      const { type } = entry;
      const { harness, deviceId } = await deviceWith(entry.flags.filter((candidate) => candidate !== flag));
      const capabilityReads = vi.spyOn(harness.stores.devices, 'get');
      const blobReads = vi.spyOn(harness.stores.blobs, 'getDownloadUrl');

      const host = hostCopy(entry);
      const run = ENQUEUE[type]!(harness, deviceId, host.payload as never);
      if (submitExpressible(host)) {
        await expect(run).rejects.toMatchObject({
          code: 'agent_capability_missing',
          message: expect.stringContaining(flag),
        });
      } else {
        await expectTerminalProjectionRequired(run);
        expect(capabilityReads).toHaveBeenCalledTimes(0);
      }
      if (type === 'task.steer' && flag === INPUT_IMAGES_CAPABILITY) expect(blobReads).not.toHaveBeenCalled();
      expect(await harness.cloud.readTaskAttempt(TENANT_A, 'gated')).toBeUndefined();
      const page = await harness.core.mailbox.readAfter(TENANT_A, { deviceId, afterSeq: 0, limit: 10 });
      expect(page.messages).toEqual([]);
    },
  );

  it.each(gatedLines.map((entry) => [entry.line, entry.variant ?? entry.type, entry] as const))(
    'corpus line %i (%s) is not refused for a capability when the device advertises every flag the table requires',
    async (_line, _label, entry) => {
      const { type } = entry;
      const { harness, deviceId } = await deviceWith(entry.flags, entry.payload);
      const host = hostCopy(entry);
      const run = ENQUEUE[type]!(harness, deviceId, host.payload as never);
      if (submitExpressible(host)) expect(await errorCode(run)).not.toBe('agent_capability_missing');
      else await expectTerminalProjectionRequired(run);
    },
  );
});
