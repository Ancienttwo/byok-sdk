import { createMutableClock } from '@byok-sdk/core';
import { sealContent } from '@byok-sdk/core/sealed-payload';
import {
  AGENT_MEMORY_PROJECTION_CAPABILITY,
  BYOK_AGENT_MEMORY_PROJECTIONS_PATH,
  type AgentMemoryProjectionMutation,
  type AgentMemoryProjectionPlainMutation,
  type AgentMemoryProjectionSealedMutation,
} from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import {
  AGENT_HOME_CONTRACT_CAPABILITY,
  InMemoryAgentMemoryProjectionAuthorizer,
  InMemoryAgentMemoryProjectionStore,
  createInMemoryByokCloud,
  createWebCrypto,
  fullCapabilityDeclaration,
} from '..';
import { base64UrlEncode } from '../crypto/web-crypto';
import { TENANT_A, createHarness } from './support/harness';

const AGENT_REF = { agentId: 'agent-memory', profileRevision: 'profile-r1' } as const;
const TASK_ID = 'agent-memory-task';
const GRANT_REF = 'opaque-grant-memory';

function agentPayload() {
  return {
    instruction: 'run an Agent memory task',
    agentRef: AGENT_REF,
    session: { mode: 'resume', sessionRef: 'session-resume-1' } as const,
  };
}

function memoryHarness() {
  const clock = createMutableClock();
  const crypto = createWebCrypto();
  const authorizer = new InMemoryAgentMemoryProjectionAuthorizer();
  const store = new InMemoryAgentMemoryProjectionStore(clock, crypto);
  return {
    authorizer,
    store,
    crypto,
    harness: createHarness({
      clock,
      crypto,
      agentMemoryProjectionAuthorizer: authorizer,
      agentMemoryProjectionStore: store,
    }),
  };
}

async function mutation(
  crypto: ReturnType<typeof createWebCrypto>,
  overrides: Partial<AgentMemoryProjectionPlainMutation> = {},
): Promise<AgentMemoryProjectionPlainMutation> {
  const bytes = new TextEncoder().encode('redacted MEMORY.md and notes snapshot');
  return {
    taskId: TASK_ID,
    agentRef: AGENT_REF,
    sessionRef: 'session-memory',
    runtimeId: 'codex',
    grantRef: GRANT_REF,
    writerEpoch: 1,
    sourceSeq: 1,
    mutationId: '10000000-0000-4000-8000-000000000011',
    policyRevision: 'policy-memory-r1',
    snapshot: {
      redactedHash: await crypto.sha256(bytes),
      redactedByteCount: bytes.byteLength,
      redactedBytes: base64UrlEncode(bytes),
    },
    ...overrides,
  };
}

async function prepareTask() {
  const composition = memoryHarness();
  const device = await composition.harness.pairDevice(TENANT_A);
  await composition.harness.stores.devices.recordCapabilities(TENANT_A, {
    deviceId: device.deviceId,
    capabilities: [AGENT_HOME_CONTRACT_CAPABILITY],
  });
  await composition.harness.cloud.enqueueAgentOffer(TENANT_A, device.deviceId, {
    taskId: TASK_ID,
    payload: agentPayload(),
  });
  const body = await mutation(composition.crypto);
  composition.authorizer.grant({
    tenantId: TENANT_A,
    deviceId: device.deviceId,
    taskId: body.taskId,
    agentRef: body.agentRef,
    sessionRef: body.sessionRef,
    runtimeId: body.runtimeId,
    grantRef: body.grantRef,
    writerEpoch: body.writerEpoch,
    policyRevision: body.policyRevision,
  });
  return { ...composition, device, body };
}

async function post(
  harness: Awaited<ReturnType<typeof prepareTask>>['harness'],
  authorization: Record<string, string>,
  body: AgentMemoryProjectionMutation,
) {
  return harness.request(BYOK_AGENT_MEMORY_PROJECTIONS_PATH, {
    method: 'POST',
    headers: { ...authorization, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('in-memory Agent-memory hosted projection conformance', () => {
  it('is default-off and refuses an over-declared incomplete capability', () => {
    const defaultCloud = createInMemoryByokCloud();
    expect(defaultCloud.cloud.capabilities.capabilities).not.toContain(AGENT_MEMORY_PROJECTION_CAPABILITY);
    const authorizer = new InMemoryAgentMemoryProjectionAuthorizer();
    expect(() => createInMemoryByokCloud({
      capabilities: fullCapabilityDeclaration(undefined, { includeAgentMemoryProjection: true }),
      agentMemoryProjectionAuthorizer: authorizer,
    })).toThrow(/agent\.memory\.projection/u);
  });

  it('binds one accepted redacted snapshot to authenticated tenant/device/task/AgentRef and exact grant identity', async () => {
    const { harness, device, body } = await prepareTask();
    expect(harness.cloud.capabilities.capabilities).toContain(AGENT_MEMORY_PROJECTION_CAPABILITY);
    const response = await post(harness, device.authorization, body);
    expect(response.status).toBe(200);
    const receipt = await response.json() as Record<string, unknown>;
    expect(receipt).toMatchObject({
      outcome: 'accepted', taskId: TASK_ID, agentRef: AGENT_REF,
      redactedHash: body.snapshot.redactedHash, redactedByteCount: body.snapshot.redactedByteCount,
      metering: { acceptedRedactedBytes: body.snapshot.redactedByteCount },
    });
    expect(receipt).not.toHaveProperty('redactedBytes');
    expect(receipt).not.toHaveProperty('cwd');

    const replay = await post(harness, device.authorization, body);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      outcome: 'idempotent', metering: (receipt as { metering: unknown }).metering,
    });
  });

  it('fails closed for device, AgentRef, session/runtime/policy/grant epoch, and redacted-hash mismatches', async () => {
    const { harness, device, body } = await prepareTask();
    const other = await harness.pairDevice(TENANT_A);
    expect((await post(harness, other.authorization, body)).status).toBe(409);
    expect((await post(harness, device.authorization, {
      ...body,
      agentRef: { ...body.agentRef, profileRevision: 'profile-r2' },
    })).status).toBe(409);
    expect((await post(harness, device.authorization, { ...body, sessionRef: 'different-session' })).status).toBe(409);
    expect((await post(harness, device.authorization, { ...body, runtimeId: 'pi' })).status).toBe(409);
    expect((await post(harness, device.authorization, {
      ...body, policyRevision: 'policy-memory-r2',
    })).status).toBe(409);
    const wrongEpoch = await post(harness, device.authorization, {
      ...body, writerEpoch: body.writerEpoch + 1,
    });
    expect(wrongEpoch.status).toBe(409);
    expect(await wrongEpoch.json()).toEqual({ error: 'agent_memory_projection_authorization_denied' });
    expect((await post(harness, device.authorization, {
      ...body,
      snapshot: { ...body.snapshot, redactedHash: `sha256:${'b'.repeat(64)}` },
    })).status).toBe(422);
  });

  it('retires lower-epoch permits for one Agent while preserving exact same-epoch permits', async () => {
    const { authorizer, device, body } = await prepareTask();
    const taskB = {
      ...body,
      taskId: 'agent-memory-task-b',
      sessionRef: 'session-memory-b',
    };
    const grantA = {
      tenantId: TENANT_A,
      deviceId: device.deviceId,
      taskId: body.taskId,
      agentRef: body.agentRef,
      sessionRef: body.sessionRef,
      runtimeId: body.runtimeId,
      grantRef: body.grantRef,
      writerEpoch: 1,
      policyRevision: body.policyRevision,
    };
    const grantB = { ...grantA, taskId: taskB.taskId, sessionRef: taskB.sessionRef };
    const authorize = (input: typeof grantA) => authorizer.authorize(input);

    authorizer.grant(grantA);
    authorizer.grant(grantB);
    await expect(authorize(grantA)).resolves.toEqual({ outcome: 'authorized' });
    await expect(authorize(grantB)).resolves.toEqual({ outcome: 'authorized' });

    const newerGrant = { ...grantA, writerEpoch: 2 };
    authorizer.grant(newerGrant);
    await expect(authorize(grantA)).resolves.toEqual({
      outcome: 'denied',
      reasonCode: 'grant_not_authorized',
    });
    await expect(authorize(grantB)).resolves.toEqual({
      outcome: 'denied',
      reasonCode: 'grant_not_authorized',
    });
    await expect(authorize(newerGrant)).resolves.toEqual({ outcome: 'authorized' });

    // A delayed lower-epoch host grant cannot revive the retired permit.
    authorizer.grant(grantA);
    await expect(authorize(grantA)).resolves.toEqual({
      outcome: 'denied',
      reasonCode: 'grant_not_authorized',
    });
  });

  it('rejects gaps, stale epochs, and same epoch/sequence replay mismatches without double-metering', async () => {
    const { harness, device, body, authorizer } = await prepareTask();
    expect((await post(harness, device.authorization, body)).status).toBe(200);
    expect((await post(harness, device.authorization, { ...body, sourceSeq: 3 })).status).toBe(409);
    expect((await post(harness, device.authorization, {
      ...body, sourceSeq: 2, mutationId: '10000000-0000-4000-8000-000000000012',
    })).status).toBe(200);
    authorizer.grant({
      tenantId: TENANT_A,
      deviceId: device.deviceId,
      taskId: body.taskId,
      agentRef: body.agentRef,
      sessionRef: body.sessionRef,
      runtimeId: body.runtimeId,
      grantRef: body.grantRef,
      writerEpoch: 2,
      policyRevision: body.policyRevision,
    });
    expect((await post(harness, device.authorization, {
      ...body, writerEpoch: 2, sourceSeq: 1, mutationId: '10000000-0000-4000-8000-000000000013',
    })).status).toBe(200);
    expect((await post(harness, device.authorization, {
      ...body, writerEpoch: 1, sourceSeq: 3, mutationId: '10000000-0000-4000-8000-000000000014',
    })).status).toBe(409);
    expect((await post(harness, device.authorization, {
      ...body, writerEpoch: 2, sourceSeq: 1, mutationId: '10000000-0000-4000-8000-000000000015',
    })).status).toBe(409);
  });

  it('revokes authorization and erases on the server without an online device', async () => {
    const { harness, device, body } = await prepareTask();
    expect((await post(harness, device.authorization, body)).status).toBe(200);
    await expect(harness.cloud.eraseAgentMemoryProjection(TENANT_A, AGENT_REF.agentId)).resolves.toEqual({ nextWriterEpoch: 2 });
    const replayAfterRevoke = await post(harness, device.authorization, body);
    expect(replayAfterRevoke.status).toBe(409);
    expect(await replayAfterRevoke.json()).toEqual({ error: 'agent_memory_projection_authorization_denied' });
  });
});

describe('a sealed snapshot under a sealing grant (#1045 S4)', () => {
  const SEALING = { scopeId: 'scope-agent-memory', epoch: 3 } as const;

  /** The mutation of `plain` with its snapshot sealed under `scope`, as the device seals it; the Host reads only outer fields. */
  async function sealedMutation(
    plain: AgentMemoryProjectionPlainMutation,
    scope: { readonly id: string; readonly epoch: number } = { id: SEALING.scopeId, epoch: SEALING.epoch },
  ): Promise<AgentMemoryProjectionSealedMutation> {
    const { snapshot, ...identity } = plain;
    const content = await sealContent({
      scopeKey: Uint8Array.from({ length: 32 }, (_, index) => index + 1),
      scope,
      chainHead: { seq: 1, hash: `sha256:${'a'.repeat(64)}` },
      sender: 'A'.repeat(43),
      category: 'memory-projection',
      binding: {
        tenantId: TENANT_A,
        family: 'agent.memory.projection',
        direction: 'daemon-to-server',
        identity: { agentId: plain.agentRef.agentId, writerEpoch: plain.writerEpoch, sourceSeq: plain.sourceSeq, mutationId: plain.mutationId },
        deviceId: 'device-memory',
        agentRef: plain.agentRef,
        categories: ['memory-projection'],
        notAfter: null,
      },
      plaintext: { redactedBytes: snapshot.redactedBytes },
      maxContentLength: 262140,
    });
    return {
      ...identity,
      sealed: { ...content.header, category: 'memory-projection', ciphertext: base64UrlEncode(content.ciphertext) },
    } as AgentMemoryProjectionSealedMutation;
  }

  /** A task whose grant carries `sealing`, or none. */
  async function grantedTask(sealing: typeof SEALING | undefined) {
    const prepared = await prepareTask();
    const { body, device } = prepared;
    prepared.authorizer.grant({
      tenantId: TENANT_A, deviceId: device.deviceId, taskId: body.taskId, agentRef: body.agentRef,
      sessionRef: body.sessionRef, runtimeId: body.runtimeId, grantRef: body.grantRef,
      writerEpoch: body.writerEpoch, policyRevision: body.policyRevision,
      ...(sealing === undefined ? {} : { sealing }),
    });
    return prepared;
  }

  it('stores the sealed member as received, meters its padded length, and replays it by contentMac', async () => {
    const { harness, device, body } = await grantedTask(SEALING);
    const sealed = await sealedMutation(body);
    const response = await post(harness, device.authorization, sealed);
    expect(response.status).toBe(200);
    const receipt = await response.json() as Record<string, unknown>;
    expect(receipt).toMatchObject({
      outcome: 'accepted', contentMac: sealed.sealed.contentMac, paddedLength: sealed.sealed.paddedLength,
      metering: { acceptedPaddedBytes: sealed.sealed.paddedLength },
    });
    expect(receipt).not.toHaveProperty('redactedHash');
    expect(receipt).not.toHaveProperty('redactedByteCount');
    expect(await (await post(harness, device.authorization, sealed)).json()).toEqual({ ...receipt, outcome: 'idempotent' });

    // Other content at the same position names a different contentMac.
    const other = await mutation(createWebCrypto(), { snapshot: { ...body.snapshot, redactedBytes: base64UrlEncode(new TextEncoder().encode('other')) } });
    const changed = await post(harness, device.authorization, await sealedMutation(other));
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({ error: 'agent_memory_projection_replay_mismatch' });
  });

  it.each([
    ['a plaintext snapshot under a sealing grant', SEALING, (body: AgentMemoryProjectionPlainMutation) => Promise.resolve(body)],
    ['a sealed snapshot under a plaintext grant', undefined, (body: AgentMemoryProjectionPlainMutation) => sealedMutation(body)],
    ['a snapshot sealed under another scope epoch', SEALING, (body: AgentMemoryProjectionPlainMutation) =>
      sealedMutation(body, { id: SEALING.scopeId, epoch: SEALING.epoch + 1 })],
  ] as const)('refuses %s with 409 and stores nothing', async (_name, sealing, form) => {
    const { harness, device, body, store } = await grantedTask(sealing);
    const response = await post(harness, device.authorization, await form(body));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'agent_memory_projection_sealing_mismatch' });
    await expect(store.erase({ tenantId: TENANT_A, agentId: AGENT_REF.agentId })).resolves.toEqual({ nextWriterEpoch: 1 });
  });
});
