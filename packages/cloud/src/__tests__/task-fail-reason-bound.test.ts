/**
 * A `task.fail` reason is bounded by the protocol schema on decode (#1124).
 * Unbounded, credential-bearing bytes on the wire are accepted, not refused,
 * and the terminal receipt, `task.terminal_cause` and the observer hold only
 * the redacted, capped reason. The Host still records the terminal state.
 */
import type { TenantId } from '@byok-sdk/core';
import { PROTOCOL_VERSION, TASK_FAIL_REASON_MAX_BYTES, createEnvelope, decodeEnvelope, encodeEnvelope, type Envelope } from '@byok-sdk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleInboundEnvelope, type ByokCloudObserver } from '../inbound';
import { tenantStoresFor, type TenantStores } from '../tenant-stores';
import { TENANT_A, TEST_AGENT_REF, createHarness, grantAgentHome, offerPayload, type CloudHarness } from './support/harness';

const FAKE_KEY = ['sk', 'proj', 'Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6'].join('-');
const FAKE_BEARER = 'opaqueBearerValue0123456789';
const bytes = (text: string) => new TextEncoder().encode(text).length;

function devicePrincipal(tenant: TenantId, deviceId: string) {
  return { kind: 'device', tenantId: tenant, productId: 'test-product', deviceId } as const;
}

describe('task.fail reason ingest (#1124)', () => {
  let harness: CloudHarness;
  let stores: TenantStores;
  let deviceId: string;

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

  async function claimedTask(): Promise<string> {
    const { taskId } = await harness.cloud.enqueueAgentOffer(TENANT_A, deviceId, { payload: offerPayload() });
    const claimed = await handleInboundEnvelope(stores, deviceId,
      createEnvelope('task.claim', { deviceId, agentRef: TEST_AGENT_REF }, { taskId }));
    expect(claimed.outcome).toBe('accepted');
    return taskId;
  }

  /** Wire bytes whose reason was never bounded by `createEnvelope`. */
  function unboundedFail(taskId: string, reason: string): Envelope {
    return decodeEnvelope(encodeEnvelope({ v: PROTOCOL_VERSION, id: crypto.randomUUID(), ts: new Date().toISOString(), type: 'task.fail',
      task_id: taskId, payload: { reason, retryable: false, agentRef: TEST_AGENT_REF } } as never));
  }

  it('accepts an over-long, credential-bearing reason from the wire and records it bounded and redacted', async () => {
    const taskId = await claimedTask();
    const reason = `app-server exited (code=1); stderr: Authorization: Bearer ${FAKE_BEARER} OPENAI_API_KEY=${FAKE_KEY} ${'e'.repeat(64 * 1024)}`;
    const committed: Envelope[] = [];
    const observer: ByokCloudObserver = { onInboundCommitted: ({ envelope }) => { committed.push(envelope); } };

    const result = await handleInboundEnvelope(stores, deviceId, unboundedFail(taskId, reason), undefined, undefined, observer);
    expect(result.outcome).toBe('accepted');

    const attempt = await harness.cloud.readTaskAttempt(TENANT_A, taskId);
    expect(attempt?.status).toBe('failed');
    const cause = attempt?.terminalCause ?? '';
    expect(cause).toMatch(/^app-server exited \(code=1\); stderr: Authorization: \[redacted\] OPENAI_API_KEY=\[redacted\] e+\u2026\[truncated \d+ bytes\]$/u);
    expect(bytes(cause)).toBeLessThanOrEqual(TASK_FAIL_REASON_MAX_BYTES);

    const read = await harness.cloud.readTaskResult(TENANT_A, taskId);
    expect(read).toMatchObject({ state: 'failed', reason: cause, terminalCause: cause, retryable: false });

    const receipt = await harness.cloud.readTerminalReceipt(TENANT_A, taskId);
    const receiptText = JSON.stringify(receipt);
    for (const secret of [FAKE_KEY, FAKE_BEARER]) {
      expect(receiptText).not.toContain(secret);
      expect(JSON.stringify(committed)).not.toContain(secret);
    }
    expect((committed[0]?.payload as { reason?: string } | undefined)?.reason).toBe(cause);
  });

  it('leaves a short, clean reason byte-identical', async () => {
    const taskId = await claimedTask();
    const result = await handleInboundEnvelope(stores, deviceId,
      createEnvelope('task.fail', { reason: 'claude exited before yielding an authoritative session id', retryable: true, agentRef: TEST_AGENT_REF }, { taskId }));
    expect(result.outcome).toBe('accepted');
    expect((await harness.cloud.readTaskAttempt(TENANT_A, taskId))?.terminalCause).toBe('claude exited before yielding an authoritative session id');
  });
});
