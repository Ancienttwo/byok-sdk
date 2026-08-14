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
import { TENANT_A, createHarness, offerPayload, type CloudHarness } from './support/harness';

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

describe('readTaskResult', () => {
  let harness: CloudHarness;
  let stores: TenantStores;
  let deviceId: string;

  beforeEach(async () => {
    harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    deviceId = device.deviceId;
    stores = tenantStoresFor(devicePrincipal(TENANT_A, deviceId), {
      core: harness.core,
      cloud: harness.stores,
    });
  });

  /** An offered and claimed task, ready to be terminated. */
  async function readyTask(): Promise<string> {
    const { taskId } = await harness.cloud.enqueueOffer(TENANT_A, deviceId, {
      payload: offerPayload(),
    });
    await handleInboundEnvelope(stores, deviceId, createEnvelope('task.claim', { deviceId }, { taskId }));
    return taskId;
  }

  it('projects a completed terminal verbatim, document and artifacts included', async () => {
    const taskId = await readyTask();
    const artifactRefs = [blobRef()];
    const document = { score: 9, notes: ['tight', 'loose'] };
    const outcome = await handleInboundEnvelope(
      stores,
      deviceId,
      createEnvelope(
        'task.complete',
        { summary: 'did the thing', sessionRef: 'session-1', artifactRefs, document },
        { taskId },
      ),
    );
    expect(outcome).toBe('accepted');

    const result = await harness.cloud.readTaskResult(TENANT_A, taskId);
    expect(result?.taskId).toBe(taskId);
    expect(result?.state).toBe('complete');
    expect(result?.summary).toBe('did the thing');
    expect(result?.sessionRef).toBe('session-1');
    expect(result?.artifactRefs).toEqual(artifactRefs);
    expect(result?.document).toEqual(document);
    expect(result?.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('projects a failed terminal reason and retryable', async () => {
    const taskId = await readyTask();
    const outcome = await handleInboundEnvelope(
      stores,
      deviceId,
      createEnvelope('task.fail', { reason: 'runtime crashed', retryable: true }, { taskId }),
    );
    expect(outcome).toBe('accepted');

    const result = await harness.cloud.readTaskResult(TENANT_A, taskId);
    expect(result?.state).toBe('failed');
    expect(result?.reason).toBe('runtime crashed');
    expect(result?.retryable).toBe(true);
    expect(result?.summary).toBeUndefined();
  });

  it('projects a cancelled terminal, with and without a reason', async () => {
    const explained = await readyTask();
    await handleInboundEnvelope(
      stores,
      deviceId,
      createEnvelope('task.cancelled', { reason: 'user asked' }, { taskId: explained }),
    );
    const withReason = await harness.cloud.readTaskResult(TENANT_A, explained);
    expect(withReason?.state).toBe('cancelled');
    expect(withReason?.reason).toBe('user asked');

    const silent = await readyTask();
    await handleInboundEnvelope(
      stores,
      deviceId,
      createEnvelope('task.cancelled', {}, { taskId: silent }),
    );
    const bare = await harness.cloud.readTaskResult(TENANT_A, silent);
    expect(bare?.state).toBe('cancelled');
    expect(bare && Object.hasOwn(bare, 'reason')).toBe(false);
  });

  it('leaves document ABSENT — not null, not synthesized — for a legacy completed terminal', async () => {
    const taskId = await readyTask();
    await handleInboundEnvelope(
      stores,
      deviceId,
      createEnvelope('task.complete', { summary: 'ok', sessionRef: 'session-1' }, { taskId }),
    );

    const result = await harness.cloud.readTaskResult(TENANT_A, taskId);
    expect(result?.summary).toBe('ok');
    expect(result?.document).toBeUndefined();
    expect(result && Object.hasOwn(result, 'document')).toBe(false);
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
