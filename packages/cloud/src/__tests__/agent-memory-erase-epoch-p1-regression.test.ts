import { createMutableClock } from '@byok-sdk/core';
import {
  AGENT_MEMORY_PROJECTION_CAPABILITY,
  BYOK_AGENT_MEMORY_PROJECTIONS_PATH,
  type AgentMemoryProjectionCommitRequest,
} from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import {
  AGENT_HOME_CONTRACT_CAPABILITY,
  InMemoryAgentMemoryProjectionAuthorizer,
  InMemoryAgentMemoryProjectionStore,
  createWebCrypto,
} from '..';
import { base64UrlEncode } from '../crypto/web-crypto';
import { TENANT_A, createHarness } from './support/harness';

const AGENT_REF = { agentId: 'agent-memory-erase-p1', profileRevision: 'profile-r1' } as const;
const TASK_ID = 'agent-memory-erase-p1-task';
const GRANT_REF = 'opaque-grant-memory-erase-p1';

function grant(deviceId: string, writerEpoch: number) {
  return {
    tenantId: TENANT_A,
    deviceId,
    taskId: TASK_ID,
    agentRef: AGENT_REF,
    sessionRef: 'session-memory-erase-p1',
    runtimeId: 'codex' as const,
    grantRef: GRANT_REF,
    writerEpoch,
    policyRevision: 'policy-memory-erase-p1',
  };
}

async function mutation(
  crypto: ReturnType<typeof createWebCrypto>,
  overrides: Partial<AgentMemoryProjectionCommitRequest> = {},
): Promise<AgentMemoryProjectionCommitRequest> {
  const bytes = new TextEncoder().encode('redacted erase epoch snapshot');
  return {
    taskId: TASK_ID,
    agentRef: AGENT_REF,
    sessionRef: 'session-memory-erase-p1',
    runtimeId: 'codex',
    grantRef: GRANT_REF,
    writerEpoch: 1,
    sourceSeq: 1,
    mutationId: '10000000-0000-4000-8000-000000000201',
    policyRevision: 'policy-memory-erase-p1',
    snapshot: {
      redactedHash: await crypto.sha256(bytes),
      redactedByteCount: bytes.byteLength,
      redactedBytes: base64UrlEncode(bytes),
    },
    ...overrides,
  };
}

async function setup() {
  const clock = createMutableClock();
  const crypto = createWebCrypto();
  const authorizer = new InMemoryAgentMemoryProjectionAuthorizer();
  const store = new InMemoryAgentMemoryProjectionStore(clock, crypto);
  const harness = createHarness({
    clock,
    crypto,
    agentMemoryProjectionAuthorizer: authorizer,
    agentMemoryProjectionStore: store,
  });
  const device = await harness.pairDevice(TENANT_A);
  await harness.stores.devices.recordCapabilities(TENANT_A, {
    deviceId: device.deviceId,
    capabilities: [AGENT_HOME_CONTRACT_CAPABILITY, AGENT_MEMORY_PROJECTION_CAPABILITY],
  });
  await harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, {
    taskId: TASK_ID,
    payload: {
      instruction: 'run an Agent memory erase epoch regression task',
      policy: { mode: 'auto' },
      agentRef: AGENT_REF,
    },
  });
  return { authorizer, crypto, device, harness };
}

async function post(
  harness: Awaited<ReturnType<typeof setup>>['harness'],
  authorization: Record<string, string>,
  body: AgentMemoryProjectionCommitRequest,
) {
  return harness.request(BYOK_AGENT_MEMORY_PROJECTIONS_PATH, {
    method: 'POST',
    headers: { ...authorization, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('Agent-memory erase epoch P1 regression', () => {
  it('starts a newly granted writer epoch at sourceSeq 1 after erase', async () => {
    const { authorizer, crypto, device, harness } = await setup();
    authorizer.grant(grant(device.deviceId, 1));

    const first = await mutation(crypto);
    expect((await post(harness, device.authorization, first)).status).toBe(200);
    const second = await mutation(crypto, {
      sourceSeq: 2,
      mutationId: '10000000-0000-4000-8000-000000000202',
    });
    expect((await post(harness, device.authorization, second)).status).toBe(200);

    await expect(harness.cloud.eraseAgentMemoryProjection(TENANT_A, AGENT_REF.agentId)).resolves.toEqual({ nextWriterEpoch: 2 });

    authorizer.grant(grant(device.deviceId, 2));
    const nextEpoch = await mutation(crypto, {
      writerEpoch: 2,
      sourceSeq: 1,
      mutationId: '10000000-0000-4000-8000-000000000204',
    });
    expect((await post(harness, device.authorization, nextEpoch)).status).toBe(200);
  });

  it('requires a new writer epoch after erase before a local next sequence can replay', async () => {
    const { authorizer, crypto, device, harness } = await setup();
    authorizer.grant(grant(device.deviceId, 1));

    const first = await mutation(crypto);
    expect((await post(harness, device.authorization, first)).status).toBe(200);
    const second = await mutation(crypto, {
      sourceSeq: 2,
      mutationId: '10000000-0000-4000-8000-000000000202',
    });
    expect((await post(harness, device.authorization, second)).status).toBe(200);

    await expect(harness.cloud.eraseAgentMemoryProjection(TENANT_A, AGENT_REF.agentId)).resolves.toEqual({ nextWriterEpoch: 2 });

    // A local outbox still at epoch 1 will correctly assign sourceSeq 3. The
    // server must reject the same-epoch regrant before that mutation can meet
    // an erased (empty) head whose only legal first sequence is one.
    authorizer.grant(grant(device.deviceId, 1));
    const staleEpoch = await mutation(crypto, {
      sourceSeq: 3,
      mutationId: '10000000-0000-4000-8000-000000000203',
    });
    const staleEpochResponse = await post(harness, device.authorization, staleEpoch);
    expect(staleEpochResponse.status).toBe(409);
    expect(await staleEpochResponse.json()).toEqual({ error: 'agent_memory_projection_erased_epoch' });
  });
});
