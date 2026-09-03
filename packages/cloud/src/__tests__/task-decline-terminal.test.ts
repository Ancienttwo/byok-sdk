/**
 * `task.decline` is a terminal, and the kernel records it as one.
 *
 * A decline is the pre-claim fail-closed rejection (protocol §3.2,
 * `Offered -> Failed`). It moves the attempt to `failed` exactly like
 * `task.fail` does, so it must leave the same readable fact behind: one
 * terminal receipt under the task's terminal key, projected by
 * `readTaskResult`. Recording only the coarse status left a reader that waits
 * for a terminal and then reads the result with a `failed` attempt and nothing
 * to read.
 *
 * Everything below goes through the REAL inbound gate
 * (`handleInboundEnvelope`) and reads back through the REAL `ByokCloud` read
 * model — no receipt is hand-written here.
 */
import type { TenantId } from '@byok-sdk/core';
import { createEnvelope } from '@byok-sdk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleInboundEnvelope } from '../inbound';
import { tenantStoresFor, type TenantStores } from '../tenant-stores';
import { TENANT_A, createHarness, offerPayload, type CloudHarness } from './support/harness';

function devicePrincipal(tenant: TenantId, deviceId: string) {
  return { kind: 'device', tenantId: tenant, productId: 'test-product', deviceId } as const;
}

describe('task.decline terminal', () => {
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

  /** An offered task, NOT claimed — a decline is pre-claim by definition. */
  async function offeredTask(): Promise<string> {
    const { taskId } = await harness.cloud.enqueueOffer(TENANT_A, deviceId, {
      payload: offerPayload(),
    });
    return taskId;
  }

  it('records a readable failed result carrying the decline reason and retryable', async () => {
    const taskId = await offeredTask();
    const outcome = await handleInboundEnvelope(
      stores,
      deviceId,
      createEnvelope('task.decline', { reason: 'no runtime available', retryable: true }, { taskId }),
    );
    expect(outcome).toBe('accepted');

    const result = await harness.cloud.readTaskResult(TENANT_A, taskId);
    expect(result).toMatchObject({
      taskId,
      state: 'failed',
      reason: 'no runtime available',
      terminalCause: 'no runtime available',
      retryable: true,
    });
    expect(result?.recordedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // No claim ever happened, so there is nothing to summarize or resume.
    expect(result?.summary).toBeUndefined();
    expect(result?.sessionRef).toBeUndefined();
    expect(result && Object.hasOwn(result, 'artifactRefs')).toBe(false);

    const attempt = await harness.cloud.readTaskAttempt(TENANT_A, taskId);
    expect(attempt?.status).toBe('failed');

    // The raw receipt is the same seam the other terminals use.
    const receipt = await harness.cloud.readTerminalReceipt(TENANT_A, taskId);
    expect(receipt).toBeDefined();
  });

  it('carries the device’s own retryable verbatim, including a refusal', async () => {
    const taskId = await offeredTask();
    await handleInboundEnvelope(
      stores,
      deviceId,
      createEnvelope('task.decline', { reason: 'policy rejected', retryable: false }, { taskId }),
    );

    const result = await harness.cloud.readTaskResult(TENANT_A, taskId);
    expect(result).toMatchObject({ state: 'failed', reason: 'policy rejected', retryable: false });
  });

  it('leaves retryable ABSENT — never synthesized — when the decline omitted it', async () => {
    const taskId = await offeredTask();
    await handleInboundEnvelope(
      stores,
      deviceId,
      createEnvelope('task.decline', { reason: 'no runtime' }, { taskId }),
    );

    const result = await harness.cloud.readTaskResult(TENANT_A, taskId);
    expect(result?.state).toBe('failed');
    expect(result && Object.hasOwn(result, 'retryable')).toBe(false);
  });

  it('keeps the decline as the result when a late task.complete races it', async () => {
    const taskId = await offeredTask();
    await handleInboundEnvelope(
      stores,
      deviceId,
      createEnvelope('task.decline', { reason: 'agent home busy', retryable: true }, { taskId }),
    );
    const late = await handleInboundEnvelope(
      stores,
      deviceId,
      createEnvelope(
        'task.complete',
        { summary: 'late terminal', sessionRef: 'session-late' },
        { taskId },
      ),
    );
    expect(late).toBe('accepted');

    const result = await harness.cloud.readTaskResult(TENANT_A, taskId);
    expect(result).toMatchObject({ state: 'failed', reason: 'agent home busy', retryable: true });
    expect(result?.summary).toBeUndefined();
    expect((await harness.cloud.readTaskAttempt(TENANT_A, taskId))?.status).toBe('failed');
  });

  it('keeps a completed result when a late decline races it', async () => {
    const taskId = await offeredTask();
    await handleInboundEnvelope(stores, deviceId, createEnvelope('task.claim', { deviceId }, { taskId }));
    await handleInboundEnvelope(
      stores,
      deviceId,
      createEnvelope('task.complete', { summary: 'did the thing', sessionRef: 'session-1' }, { taskId }),
    );
    await handleInboundEnvelope(
      stores,
      deviceId,
      createEnvelope('task.decline', { reason: 'late decline', retryable: true }, { taskId }),
    );

    const result = await harness.cloud.readTaskResult(TENANT_A, taskId);
    expect(result).toMatchObject({ state: 'complete', summary: 'did the thing' });
    expect(result?.reason).toBeUndefined();
    expect((await harness.cloud.readTaskAttempt(TENANT_A, taskId))?.status).toBe('complete');
  });

  it('is idempotent for a replayed decline with a new envelope id', async () => {
    const taskId = await offeredTask();
    await handleInboundEnvelope(
      stores,
      deviceId,
      createEnvelope('task.decline', { reason: 'first decline', retryable: true }, { taskId }),
    );
    await handleInboundEnvelope(
      stores,
      deviceId,
      createEnvelope('task.decline', { reason: 'second decline', retryable: false }, { taskId }),
    );

    const result = await harness.cloud.readTaskResult(TENANT_A, taskId);
    expect(result).toMatchObject({ state: 'failed', reason: 'first decline', retryable: true });
  });
});
