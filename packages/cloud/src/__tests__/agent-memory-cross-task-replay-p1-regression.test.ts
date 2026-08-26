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

const AGENT_REF = { agentId: 'agent-memory-cross-task-p1', profileRevision: 'profile-r1' } as const;
const GRANT_REF = 'opaque-grant-memory-cross-task-p1';

function grant(deviceId: string, taskId: string, sessionRef: string) {
  return {
    tenantId: TENANT_A,
    deviceId,
    taskId,
    agentRef: AGENT_REF,
    sessionRef,
    runtimeId: 'codex' as const,
    grantRef: GRANT_REF,
    writerEpoch: 1,
    policyRevision: 'policy-memory-cross-task-p1',
  };
}

async function replayMutation(
  crypto: ReturnType<typeof createWebCrypto>,
  input: {
    readonly taskId: string;
    readonly sessionRef: string;
    readonly sourceSeq: number;
    readonly mutationId: string;
  },
): Promise<AgentMemoryProjectionCommitRequest> {
  const bytes = new TextEncoder().encode(`redacted ${input.taskId} snapshot`);
  return {
    taskId: input.taskId,
    agentRef: AGENT_REF,
    sessionRef: input.sessionRef,
    runtimeId: 'codex',
    grantRef: GRANT_REF,
    writerEpoch: 1,
    sourceSeq: input.sourceSeq,
    mutationId: input.mutationId,
    policyRevision: 'policy-memory-cross-task-p1',
    snapshot: {
      redactedHash: await crypto.sha256(bytes),
      redactedByteCount: bytes.byteLength,
      redactedBytes: base64UrlEncode(bytes),
    },
  };
}

describe('Agent-memory cross-task replay P1 regression', () => {
  it('keeps task A authorization available when task B is granted in the same epoch', async () => {
    const clock = createMutableClock();
    const crypto = createWebCrypto();
    const authorizer = new InMemoryAgentMemoryProjectionAuthorizer();
    const harness = createHarness({
      clock,
      crypto,
      agentMemoryProjectionAuthorizer: authorizer,
      agentMemoryProjectionStore: new InMemoryAgentMemoryProjectionStore(clock, crypto),
    });
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId,
      capabilities: [AGENT_HOME_CONTRACT_CAPABILITY, AGENT_MEMORY_PROJECTION_CAPABILITY],
    });
    for (const taskId of ['task-a', 'task-b']) {
      await harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, {
        taskId,
        payload: { instruction: `run ${taskId}`, policy: { mode: 'auto' }, agentRef: AGENT_REF },
      });
    }

    authorizer.grant(grant(device.deviceId, 'task-a', 'session-a'));
    const taskAMutation = await replayMutation(crypto, {
      taskId: 'task-a',
      sessionRef: 'session-a',
      sourceSeq: 1,
      mutationId: '10000000-0000-4000-8000-000000000301',
    });
    const first = await harness.request(BYOK_AGENT_MEMORY_PROJECTIONS_PATH, {
      method: 'POST',
      headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify(taskAMutation),
    });
    expect({ status: first.status, body: await first.json() }).toMatchObject({
      status: 200,
      body: { outcome: 'accepted' },
    });

    // A later task receives the same grantRef and writer epoch. It must add a
    // distinct exact permit, leaving task A's historical replay authorized.
    authorizer.grant(grant(device.deviceId, 'task-b', 'session-b'));
    const replayA = await harness.request(BYOK_AGENT_MEMORY_PROJECTIONS_PATH, {
      method: 'POST',
      headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify(taskAMutation),
    });
    expect({ status: replayA.status, body: await replayA.json() }).toMatchObject({
      status: 200,
      body: { outcome: 'idempotent' },
    });

    const taskBMutation = await replayMutation(crypto, {
      taskId: 'task-b',
      sessionRef: 'session-b',
      sourceSeq: 2,
      mutationId: '10000000-0000-4000-8000-000000000302',
    });
    const response = await harness.request(BYOK_AGENT_MEMORY_PROJECTIONS_PATH, {
      method: 'POST',
      headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify(taskBMutation),
    });

    expect({ status: response.status, body: await response.json() }).toMatchObject({
      status: 200,
      body: { outcome: 'accepted' },
    });
  });
});
