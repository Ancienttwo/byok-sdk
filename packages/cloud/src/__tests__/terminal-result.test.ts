/**
 * `readTaskResult` — the typed terminal read model, driven end to end.
 *
 * Every terminal below lands through the REAL inbound gate
 * (`handleInboundEnvelope`), so what is asserted is the projection of what
 * the gate actually stored — not a receipt the test wrote itself. The one
 * hand-written receipt is the fail-closed case: a store row that is not a
 * terminal envelope is a broken receipt-store contract, and the read model
 * must say so, never shape a best-effort result around it.
 */
import type { TenantId } from '@byok-sdk/core';
import { type BlobRef, createEnvelope, encodeEnvelope } from '@byok-sdk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { isCloudError } from '../errors';
import { handleInboundEnvelope, terminalReceiptKey } from '../inbound';
import { tenantStoresFor, type TenantStores } from '../tenant-stores';
import { TENANT_A, TEST_AGENT_REF, createHarness, grantAgentHome, offerPayload, type CloudHarness } from './support/harness';

function devicePrincipal(tenant: TenantId, deviceId: string) {
  return { kind: 'device', tenantId: tenant, productId: 'test-product', deviceId } as const;
}

function blobRef(): BlobRef {
  return {
    blobId: 'blob-1',
    contentHash: 'sha256:a'.padEnd(71, '0'),
    size: 3,
    contentType: 'text/plain',
  };
}

const projectionEvidence = { profileRevision: '3', projectionHash: `sha256:${'3'.repeat(64)}` };

const terminalUsage = {
  runtime: 'codex' as const,
  promptTokens: 120,
  completionTokens: 45,
  durationMs: 2_500,
  clientVersion: '0.6.0',
  reportedAt: '2026-08-21T10:00:02.500Z',
};

describe('readTaskResult', () => {
  let harness: CloudHarness;
  let stores: TenantStores;
  let deviceId: string;

  it.each(['agent_home_writer_busy', 'agent_home_reader_busy', undefined] as const)(
    'projects decline code %s verbatim from the winning terminal', async (code) => {
      const taskId = 'typed-decline';
      await harness.cloud.enqueueAgentOffer(TENANT_A, deviceId, { taskId, payload: offerPayload() });
      const payload = { reason: 'display only', retryable: true, agentRef: TEST_AGENT_REF, ...(code === undefined ? {} : { code }) };
      const envelope = createEnvelope('task.decline', payload, { taskId });
      expect(await handleInboundEnvelope(stores, deviceId, envelope).then(r => r.outcome)).toBe('accepted');
      expect(await harness.cloud.readTaskResult(TENANT_A, taskId)).toMatchObject({ state: 'failed', ...payload });
      expect(await harness.cloud.readDeviceTerminal(TENANT_A, taskId)).toMatchObject({ envelope });
      if (code === undefined) expect(await harness.cloud.readTaskResult(TENANT_A, taskId)).not.toHaveProperty('code');
    },
  );

  it('keeps host cancel separate from typed device terminal evidence', async () => {
    const taskId = 'cancel-before-terminal';
    await harness.cloud.enqueueAgentOffer(TENANT_A, deviceId, { taskId, payload: offerPayload() });
    await handleInboundEnvelope(stores, deviceId, createEnvelope('task.claim', { deviceId, agentRef: TEST_AGENT_REF }, { taskId })).then((result) => result.outcome);
    await harness.cloud.cancelTask(TENANT_A, taskId, 'host stop');
    expect(await harness.cloud.readTaskResult(TENANT_A, taskId)).toMatchObject({ state: 'cancelled' });
    expect(await harness.cloud.readDeviceTerminal(TENANT_A, taskId)).toBeUndefined();
    const terminal = createEnvelope('task.complete', { agentRef: TEST_AGENT_REF, summary: 'already finished', sessionRef: 'native-session' }, { taskId });
    await handleInboundEnvelope(stores, deviceId, terminal).then((result) => result.outcome);
    expect(await harness.cloud.readDeviceTerminal(TENANT_A, taskId)).toMatchObject({ envelope: terminal });
    expect(await harness.cloud.readTaskResult(TENANT_A, taskId)).toMatchObject({ state: 'cancelled' });
  });

  it('rejects a terminal stored under another task identity', async () => {
    await harness.stores.receipts.record(TENANT_A, { key: terminalReceiptKey('target'),
      body: encodeEnvelope(createEnvelope('task.complete', { summary: 'wrong task', sessionRef: 'session' }, { taskId: 'other' })) });
    await expect(harness.cloud.readDeviceTerminal(TENANT_A, 'target')).rejects.toThrow();
  });

  beforeEach(async () => {
    harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    deviceId = device.deviceId;
    await grantAgentHome(harness, TENANT_A, deviceId);
    stores = tenantStoresFor(devicePrincipal(TENANT_A, deviceId), {
      core: harness.core,
      cloud: harness.stores,
      mailboxWake: harness.mailboxWake,
    });
  });

  /** An offered and claimed task, ready to be terminated. */
  async function readyTask(): Promise<string> {
    const { taskId } = await harness.cloud.enqueueAgentOffer(TENANT_A, deviceId, {
      payload: offerPayload(),
    });
    await handleInboundEnvelope(stores, deviceId, createEnvelope('task.claim', { deviceId, agentRef: TEST_AGENT_REF }, { taskId })).then((result) => result.outcome);
    return taskId;
  }

  it('projects a completed terminal verbatim, document and artifacts included', async () => {
    const taskId = await readyTask();
    const artifactRefs = [blobRef()];
    const document = { score: 9, notes: ['tight', 'loose'] };
    const agentHomeProjection = { profileRevision: '3', projectionHash: `sha256:${'3'.repeat(64)}` };
    const outcome = await handleInboundEnvelope(
      stores,
      deviceId,
      createEnvelope(
        'task.complete',
        { agentRef: TEST_AGENT_REF, summary: 'Working on it.did the thing', finalMessage: 'did the thing', sessionRef: 'session-1', artifactRefs, document, usage: terminalUsage, agentHomeProjection },
        { taskId },
      ),
    ).then((result) => result.outcome);
    expect(outcome).toBe('accepted');

    const result = await harness.cloud.readTaskResult(TENANT_A, taskId);
    expect(result?.taskId).toBe(taskId);
    expect(result?.state).toBe('complete');
    expect(result?.summary).toBe('Working on it.did the thing');
    expect(result?.finalMessage).toBe('did the thing');
    expect(result?.agentHomeProjection).toEqual(agentHomeProjection);
    expect(result?.sessionRef).toBe('session-1');
    expect(result?.artifactRefs).toEqual(artifactRefs);
    expect(result?.document).toEqual(document);
    expect(result?.usage).toEqual(terminalUsage);
    expect(result?.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('projects a failed terminal reason and retryable', async () => {
    const taskId = await readyTask();
    const outcome = await handleInboundEnvelope(
      stores,
      deviceId,
      createEnvelope('task.fail', { agentRef: TEST_AGENT_REF, reason: 'runtime crashed', retryable: true, usage: terminalUsage, agentHomeProjection: projectionEvidence }, { taskId }),
    ).then((result) => result.outcome);
    expect(outcome).toBe('accepted');

    const result = await harness.cloud.readTaskResult(TENANT_A, taskId);
    expect(result?.state).toBe('failed');
    expect(result?.reason).toBe('runtime crashed');
    expect(result?.retryable).toBe(true);
    expect(result?.usage).toEqual(terminalUsage);
    expect(result?.agentHomeProjection).toEqual(projectionEvidence);
    expect(result?.summary).toBeUndefined();
  });

  it('projects the prepared-only observation verbatim from task.complete and task.fail', async () => {
    const preparedObservation = { requestDigest: 'a'.repeat(64), initialPromptTokens: 812, maxPromptTokens: 2_048 };
    const completed = await readyTask();
    await handleInboundEnvelope(
      stores,
      deviceId,
      createEnvelope('task.complete', { agentRef: TEST_AGENT_REF, summary: 's', sessionRef: 'session-p', preparedObservation }, { taskId: completed }),
    ).then((result) => result.outcome);
    expect((await harness.cloud.readTaskResult(TENANT_A, completed))?.preparedObservation).toEqual(preparedObservation);

    const overflowed = await readyTask();
    await handleInboundEnvelope(
      stores,
      deviceId,
      createEnvelope(
        'task.fail',
        { agentRef: TEST_AGENT_REF, reason: 'context_overflow: provider call 2', retryable: false, preparedObservation },
        { taskId: overflowed },
      ),
    ).then((result) => result.outcome);
    const failed = await harness.cloud.readTaskResult(TENANT_A, overflowed);
    expect(failed).toMatchObject({ state: 'failed', retryable: false, preparedObservation });
    expect(failed?.reason?.startsWith('context_overflow')).toBe(true);
  });

  it('projects a cancelled terminal, with and without a reason', async () => {
    const explained = await readyTask();
    await handleInboundEnvelope(
      stores,
      deviceId,
      createEnvelope('task.cancelled', { agentRef: TEST_AGENT_REF, reason: 'user asked', usage: terminalUsage, agentHomeProjection: projectionEvidence }, { taskId: explained }),
    ).then((result) => result.outcome);
    const withReason = await harness.cloud.readTaskResult(TENANT_A, explained);
    expect(withReason?.state).toBe('cancelled');
    expect(withReason?.reason).toBe('user asked');
    expect(withReason?.usage).toEqual(terminalUsage);
    expect(withReason?.agentHomeProjection).toEqual(projectionEvidence);

    const silent = await readyTask();
    await handleInboundEnvelope(
      stores,
      deviceId,
      createEnvelope('task.cancelled', { agentRef: TEST_AGENT_REF }, { taskId: silent }),
    ).then((result) => result.outcome);
    const bare = await harness.cloud.readTaskResult(TENANT_A, silent);
    expect(bare?.state).toBe('cancelled');
    expect(bare && Object.hasOwn(bare, 'reason')).toBe(false);
    expect(bare && Object.hasOwn(bare, 'agentHomeProjection')).toBe(false);
  });

  it('projects reader memory-change evidence verbatim from complete, fail and cancelled terminals', async () => {
    const attributed = { outcome: 'reader-attributed' as const, paths: ['MEMORY.md', 'notes/plan.md'] };
    const completed = await readyTask();
    await handleInboundEnvelope(stores, deviceId, createEnvelope('task.complete', {
      agentRef: TEST_AGENT_REF, summary: 's', sessionRef: 'reader-session', agentHomeMemoryChange: attributed,
    }, { taskId: completed })).then((result) => result.outcome);
    expect((await harness.cloud.readTaskResult(TENANT_A, completed))?.agentHomeMemoryChange).toEqual(attributed);

    const failed = await readyTask();
    await handleInboundEnvelope(stores, deviceId, createEnvelope('task.fail', {
      agentRef: TEST_AGENT_REF, reason: 'runtime crashed', retryable: false, agentHomeMemoryChange: { outcome: 'unmeasured' },
    }, { taskId: failed })).then((result) => result.outcome);
    expect((await harness.cloud.readTaskResult(TENANT_A, failed))?.agentHomeMemoryChange).toEqual({ outcome: 'unmeasured' });

    const cancelled = await readyTask();
    await handleInboundEnvelope(stores, deviceId, createEnvelope('task.cancelled', {
      agentRef: TEST_AGENT_REF, agentHomeMemoryChange: { outcome: 'unattributed', paths: ['notes/a.md'] },
    }, { taskId: cancelled })).then((result) => result.outcome);
    expect((await harness.cloud.readTaskResult(TENANT_A, cancelled))?.agentHomeMemoryChange)
      .toEqual({ outcome: 'unattributed', paths: ['notes/a.md'] });
  });

  it('leaves document ABSENT — not null, not synthesized — for a legacy completed terminal', async () => {
    const taskId = await readyTask();
    await handleInboundEnvelope(
      stores,
      deviceId,
      createEnvelope('task.complete', { agentRef: TEST_AGENT_REF, summary: 'ok', sessionRef: 'session-1' }, { taskId }),
    ).then((result) => result.outcome);

    const result = await harness.cloud.readTaskResult(TENANT_A, taskId);
    expect(result?.summary).toBe('ok');
    expect(result?.document).toBeUndefined();
    expect(result && Object.hasOwn(result, 'document')).toBe(false);
    expect(result && Object.hasOwn(result, 'finalMessage')).toBe(false);
    expect(result && Object.hasOwn(result, 'agentHomeProjection')).toBe(false);
    expect(result && Object.hasOwn(result, 'agentHomeMemoryChange')).toBe(false);
    expect(result && Object.hasOwn(result, 'usage')).toBe(false);
  });

  it('preserves the first terminal usage unchanged when a later terminal races it', async () => {
    const taskId = await readyTask();
    const winningUsage = { ...terminalUsage, runtime: 'claude' as const, promptTokens: 11 };
    const losingUsage = { ...terminalUsage, promptTokens: 999 };
    await handleInboundEnvelope(
      stores,
      deviceId,
      createEnvelope('task.fail', { agentRef: TEST_AGENT_REF, reason: 'first terminal', retryable: false, usage: winningUsage }, { taskId }),
    ).then((result) => result.outcome);
    await handleInboundEnvelope(
      stores,
      deviceId,
      createEnvelope('task.complete', { agentRef: TEST_AGENT_REF, summary: 'late terminal', sessionRef: 'session-late', usage: losingUsage }, { taskId }),
    ).then((result) => result.outcome);

    const result = await harness.cloud.readTaskResult(TENANT_A, taskId);
    expect(result).toMatchObject({ state: 'failed', reason: 'first terminal', usage: winningUsage });
  });

  it('reads undefined while no terminal fact exists', async () => {
    const taskId = await readyTask();
    expect(await harness.cloud.readTaskResult(TENANT_A, taskId)).toBeUndefined();
  });

  it('fails closed on a receipt that is not a terminal envelope', async () => {
    const garbage = await readyTask();
    await stores.receipts.record({ key: terminalReceiptKey(garbage), body: 'not an envelope' });
    await expect(harness.cloud.readTaskResult(TENANT_A, garbage)).rejects.toSatisfy((error: unknown) =>
      isCloudError(error, 'terminal_receipt_unreadable'),
    );

    // Decodable but non-terminal: the same broken store contract, same answer.
    const misfiled = await readyTask();
    await stores.receipts.record({
      key: terminalReceiptKey(misfiled),
      body: encodeEnvelope(createEnvelope('task.progress', { seq: 1, events: [] }, { taskId: misfiled })),
    });
    await expect(harness.cloud.readTaskResult(TENANT_A, misfiled)).rejects.toSatisfy(
      (error: unknown) => isCloudError(error, 'terminal_receipt_unreadable'),
    );
  });
});
