import {
  AGENT_INPUT_PREPARATION_CAPABILITY,
  byokInputPreparationCompletionPath,
  byokInputPreparationStatusPath,
  decodeEnvelope,
  type AgentRef,
  type InputPreparationReceiptSummary,
  type InputPreparationRejectionReason,
  type InputPreparationSelection,
} from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { inputPreparationRequestKey } from '../input-preparations';
import { TENANT_A, createHarness } from './support/harness';

const REQUEST_A = '10000000-0000-4000-8000-000000000301';
const REQUEST_B = '10000000-0000-4000-8000-000000000302';
const AGENT_A = { agentId: 'input-preparation-agent', profileRevision: '7' } as const;
const AGENT_B = { agentId: 'input-preparation-agent-other', profileRevision: '7' } as const;
const POLICY = 'limits-2026-09-15';

const SELECTION = {
  model: {
    id: 'model-1',
    name: 'Model One',
    api: 'openai-completions',
    provider: 'provider-1',
    baseUrl: 'https://provider.example/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  },
  options: { cacheRetention: 'none', maxTokens: 1024 },
} satisfies InputPreparationSelection;

function desired(
  requestId = REQUEST_A,
  agentRef: AgentRef = AGENT_A,
  overrides: Record<string, unknown> = {},
) {
  return {
    requestId,
    agentRef,
    profileId: 'profile-1',
    policyRevision: POLICY,
    source: { revision: 'source-r42', digest: `sha256:${'c'.repeat(64)}` },
    selection: SELECTION,
    deadlineAt: '2026-01-01T00:01:00.000Z',
    context: { inline: '{"prompt":{},"messages":[]}' },
    requiredToolsets: ['team'],
    permissionMode: 'auto' as const,
    ...overrides,
  };
}

const RECEIPT: InputPreparationReceiptSummary = {
  reference: 'prep-ref-1',
  state: 'prepared',
  binding: {
    scopeId: 'scope-1',
    deviceId: 'device-local',
    agentRef: AGENT_A.agentId,
    profileId: 'profile-1',
    profileRevision: AGENT_A.profileRevision,
    source: { revision: 'source-r42', digest: `sha256:${'c'.repeat(64)}` },
    target: { endpoint: 'https://provider.example/v1', modelId: 'model-1' },
    policyRevision: POLICY,
    permissionMode: 'auto',
    runtime: {
      packageName: '@byok-sdk/pi-coding-agent',
      packageVersion: '0.85.1001',
      upstreamBase: '0.85.1',
      upstreamCommit: 'd981de1229ef899957bbe968bc8dcda02a21f477',
      forkBuild: 1,
      envelopeFormat: 'pi.prepared-session-input.v1',
      requestFormat: 'openai-completions.v1',
      compilerVersion: 2,
    },
    requestDigest: 'sha256:req',
  },
  artifact: {
    requestDigest: 'sha256:req',
    envelopeDigest: 'sha256:env',
    toolManifestDigest: 'sha256:tools',
    requestBytes: 1024,
    projectionBytes: 900,
    projection: { version: 3, kind: 'content_complete', digest: 'a'.repeat(64) },
    residual: [{ key: 'max_tokens', valueClass: 'bounded_integer' }],
    observationDigest: 'sha256:observation',
    toolBindingDigest: 'sha256:binding',
    toolImplementationKinds: { mcp__teamserver__list: 'unavailable:resolver_unconfigured' },
  },
  ready: false,
  readinessReasons: ['accounting_policy_missing', 'executor_identity_unproven'],
  artifactExpiresAt: '2026-01-01T01:00:00.000Z',
};

function preparedCompletion(requestId = REQUEST_A, agentRef: AgentRef = AGENT_A) {
  return {
    outcome: 'prepared' as const,
    requestId,
    agentRef,
    profileId: 'profile-1',
    policyRevision: POLICY,
    receipt: RECEIPT,
  };
}

function rejectedCompletion(
  requestId = REQUEST_A,
  reason: InputPreparationRejectionReason = 'scope_denied',
) {
  return {
    outcome: 'rejected' as const,
    requestId,
    agentRef: AGENT_A,
    profileId: 'profile-1',
    policyRevision: POLICY,
    reason,
  };
}

async function admitPreparation(
  harness: ReturnType<typeof createHarness>,
  deviceId: string,
): Promise<void> {
  await harness.stores.devices.recordCapabilities(TENANT_A, {
    deviceId,
    capabilities: ['agent-home-contract', AGENT_INPUT_PREPARATION_CAPABILITY],
  });
}

describe('remote input preparation', () => {
  it('refuses a device without the durable capability before any receipt or mailbox row', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId,
      capabilities: ['agent-home-contract'],
    });

    await expect(
      harness.cloud.enqueueInputPreparation(TENANT_A, device.deviceId, desired()),
    ).rejects.toMatchObject({ code: 'agent_capability_missing' });
    await expect(
      harness.stores.receipts.get(TENANT_A, inputPreparationRequestKey(device.deviceId, AGENT_A, REQUEST_A)),
    ).resolves.toBeUndefined();
    await expect(
      harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 }),
    ).resolves.toMatchObject({ messages: [] });
  });

  it('refuses a device that declares only the retired unversioned token — version skew never reaches the mailbox', async () => {
    // A 0.19 device declares `agent-input-preparation`; this cloud speaks
    // `agent-input-preparation-v5`. Relaying would earn a strict-schema 422 on
    // the completion PUT and a permanently frozen redelivery cursor, so the
    // refusal lands at enqueue, typed, with nothing durable behind it.
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId,
      capabilities: ['agent-home-contract', 'agent-input-preparation'],
    });

    await expect(
      harness.cloud.enqueueInputPreparation(TENANT_A, device.deviceId, desired()),
    ).rejects.toMatchObject({ code: 'agent_capability_missing' });
    await expect(
      harness.stores.receipts.get(TENANT_A, inputPreparationRequestKey(device.deviceId, AGENT_A, REQUEST_A)),
    ).resolves.toBeUndefined();
    await expect(
      harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 }),
    ).resolves.toMatchObject({ messages: [] });
  });

  it('parses the strict control body before capability admission or durable allocation', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await admitPreparation(harness, device.deviceId);

    // Unsupported model API, oversize inline context, and an unknown control
    // field all reject; none of them may leave a desired fact behind.
    await expect(
      harness.cloud.enqueueInputPreparation(
        TENANT_A,
        device.deviceId,
        desired(REQUEST_A, AGENT_A, {
          selection: { ...SELECTION, model: { ...SELECTION.model, api: 'anthropic-messages' } },
        }) as never,
      ),
    ).rejects.toThrow();
    await expect(
      harness.cloud.enqueueInputPreparation(
        TENANT_A,
        device.deviceId,
        desired(REQUEST_B, AGENT_A, { context: { inline: 'x'.repeat(64 * 1024 + 1) } }),
      ),
    ).rejects.toThrow();
    await expect(
      harness.cloud.enqueueInputPreparation(
        TENANT_A,
        device.deviceId,
        desired(REQUEST_B, AGENT_A, { tools: [] }) as never,
      ),
    ).rejects.toThrow();

    for (const requestId of [REQUEST_A, REQUEST_B]) {
      await expect(
        harness.stores.receipts.get(TENANT_A, inputPreparationRequestKey(device.deviceId, AGENT_A, requestId)),
      ).resolves.toBeUndefined();
    }
    await expect(
      harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 }),
    ).resolves.toMatchObject({ messages: [] });
  });

  it('keeps the desired receipt immutable, replays exactly, and opens no TaskAttempt', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await admitPreparation(harness, device.deviceId);

    const first = await harness.cloud.enqueueInputPreparation(TENANT_A, device.deviceId, desired());
    const replay = await harness.cloud.enqueueInputPreparation(TENANT_A, device.deviceId, desired());
    expect(replay).toEqual(first);
    expect(first.status).toMatchObject({
      tenantId: TENANT_A,
      deviceId: device.deviceId,
      requestId: REQUEST_A,
      agentRef: AGENT_A,
      profileId: 'profile-1',
      policyRevision: POLICY,
      status: 'pending',
    });

    // Same requestId, different body — a different deadline is enough, because
    // the WHOLE authorized request is the immutable desired fact.
    await expect(
      harness.cloud.enqueueInputPreparation(
        TENANT_A,
        device.deviceId,
        desired(REQUEST_A, AGENT_A, { deadlineAt: '2026-01-01T00:02:00.000Z' }),
      ),
    ).rejects.toMatchObject({ code: 'input_preparation_request_conflict' });

    const page = await harness.core.mailbox.readAfter(TENANT_A, { deviceId: device.deviceId, afterSeq: 0 });
    expect(page.messages).toHaveLength(1);
    const control = decodeEnvelope(page.messages[0]!.body);
    expect(control).toMatchObject({ type: 'agent.input.preparation', seq: 1, payload: desired() });
    expect(control.task_id).toBeUndefined();
    expect(control.id).not.toBe(REQUEST_A);
    await expect(harness.cloud.readTaskAttempt(TENANT_A, REQUEST_A)).resolves.toBeUndefined();
  });

  it('isolates same-device requests by exact AgentRef', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await admitPreparation(harness, device.deviceId);

    const first = await harness.cloud.enqueueInputPreparation(TENANT_A, device.deviceId, desired(REQUEST_A, AGENT_A));
    const second = await harness.cloud.enqueueInputPreparation(TENANT_A, device.deviceId, desired(REQUEST_A, AGENT_B));
    expect(second.envelope.id).not.toBe(first.envelope.id);
    expect(inputPreparationRequestKey(device.deviceId, AGENT_A, REQUEST_A)).not.toBe(
      inputPreparationRequestKey(device.deviceId, AGENT_B, REQUEST_A),
    );
    await expect(
      harness.cloud.getInputPreparationStatus(TENANT_A, device.deviceId, { requestId: REQUEST_A, agentRef: AGENT_A }),
    ).resolves.toMatchObject({ agentRef: AGENT_A, status: 'pending' });
    await expect(
      harness.cloud.getInputPreparationStatus(TENANT_A, device.deviceId, { requestId: REQUEST_A, agentRef: AGENT_B }),
    ).resolves.toMatchObject({ agentRef: AGENT_B, status: 'pending' });
  });

  it('requires the exact authenticated device and binding, and keeps the first terminal outcome', async () => {
    const harness = createHarness();
    const target = await harness.pairDevice(TENANT_A);
    const wrongDevice = await harness.pairDevice(TENANT_A);
    await admitPreparation(harness, target.deviceId);
    await admitPreparation(harness, wrongDevice.deviceId);
    await harness.cloud.enqueueInputPreparation(TENANT_A, target.deviceId, desired());

    const complete = (authorization: { readonly authorization: string }, body: unknown) =>
      harness.request(byokInputPreparationCompletionPath(REQUEST_A), {
        method: 'PUT',
        headers: { ...authorization, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    // Another device's bearer token names its OWN device key, which holds no
    // such request at all.
    await expect(complete(wrongDevice.authorization, preparedCompletion())).resolves.toMatchObject({ status: 404 });
    await expect(
      complete(target.authorization, { ...preparedCompletion(), agentRef: { agentId: 'different', profileRevision: '7' } }),
    ).resolves.toMatchObject({ status: 404 });
    // Right request, wrong policy binding.
    await expect(
      complete(target.authorization, { ...preparedCompletion(), policyRevision: 'limits-other' }),
    ).resolves.toMatchObject({ status: 422 });
    await expect(
      harness.cloud.getInputPreparationStatus(TENANT_A, target.deviceId, { requestId: REQUEST_A, agentRef: AGENT_A }),
    ).resolves.toMatchObject({ status: 'pending' });

    const accepted = await complete(target.authorization, preparedCompletion());
    expect(accepted.status).toBe(200);
    const acceptedBody = await accepted.json();
    expect(acceptedBody).toMatchObject({
      tenantId: TENANT_A,
      deviceId: target.deviceId,
      requestId: REQUEST_A,
      agentRef: AGENT_A,
      status: 'prepared',
      receipt: RECEIPT,
    });

    // An equal replay is idempotent; a DIFFERENT terminal body conflicts.
    const replay = await complete(target.authorization, preparedCompletion());
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(acceptedBody);
    await expect(complete(target.authorization, rejectedCompletion())).resolves.toMatchObject({ status: 409 });
  });

  it('records a rejection as a terminal status carrying no artifact', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await admitPreparation(harness, device.deviceId);
    await harness.cloud.enqueueInputPreparation(TENANT_A, device.deviceId, desired());

    const response = await harness.request(byokInputPreparationCompletionPath(REQUEST_A), {
      method: 'PUT',
      headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify(rejectedCompletion(REQUEST_A, 'input_preparation_unconfigured')),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'rejected', reason: 'input_preparation_unconfigured' });
    expect(body.receipt).toBeUndefined();
  });

  it('serves a device-authenticated status readback that never crosses devices', async () => {
    const harness = createHarness();
    const target = await harness.pairDevice(TENANT_A);
    const other = await harness.pairDevice(TENANT_A);
    await admitPreparation(harness, target.deviceId);
    await admitPreparation(harness, other.deviceId);
    await harness.cloud.enqueueInputPreparation(TENANT_A, target.deviceId, desired());

    const url = `${byokInputPreparationStatusPath(REQUEST_A)}?agentId=${AGENT_A.agentId}&profileRevision=${AGENT_A.profileRevision}`;
    const pending = await harness.request(url, { headers: target.authorization });
    expect(pending.status).toBe(200);
    expect(await pending.json()).toMatchObject({ status: 'pending', deviceId: target.deviceId });

    await expect(harness.request(url, { headers: other.authorization })).resolves.toMatchObject({ status: 404 });
    await expect(harness.request(byokInputPreparationStatusPath(REQUEST_A), { headers: target.authorization }))
      .resolves.toMatchObject({ status: 422 });
    await expect(harness.request(url)).resolves.toMatchObject({ status: 401 });

    await harness.request(byokInputPreparationCompletionPath(REQUEST_A), {
      method: 'PUT',
      headers: { ...target.authorization, 'content-type': 'application/json' },
      body: JSON.stringify(preparedCompletion()),
    });
    const terminal = await harness.request(url, { headers: target.authorization });
    expect(await terminal.json()).toMatchObject({ status: 'prepared', receipt: RECEIPT });
  });

  /**
   * The undischargeable-completion regression, driven through the REAL cloud
   * HTTP handler rather than a stub completion client.
   *
   * A daemon whose `inputPreparation` section is gone (restarted without it, or
   * with an unverifiable native closure) no longer advertises
   * `agent-input-preparation`, and the only completion it can honestly produce
   * is `input_preparation_unconfigured`. Cloud must RECORD that: the mailbox is
   * strictly seq-ordered and the daemon advances its redelivery cursor only
   * once the completion PUT succeeds, so refusing it would freeze the device
   * behind a row with no terminal path — and every later envelope with it.
   *
   * Admission is unaffected: `enqueueInputPreparation` still refuses a device
   * without the flag (first test in this file), and the completion is still
   * bound to the exact authenticated device, `AgentRef` and `policyRevision`.
   */
  it.each(['input_preparation_unconfigured', 'unsupported_input'] as const)('records %s as a terminal fact without a capability flag', async (reason) => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await admitPreparation(harness, device.deviceId);
    await harness.cloud.enqueueInputPreparation(TENANT_A, device.deviceId, desired());

    // The device is now exactly what `computeCapabilities` reports for a daemon
    // with no `inputPreparation` section: no `agent-input-preparation`.
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId,
      capabilities: ['agent-home-contract'],
    });

    // The device receives the envelope exactly as it would in production —
    // reading is not acknowledging, so the cursor is still 0 here.
    const delivered = await harness.request('/byok/events?cursor=0', { headers: device.authorization });
    expect(delivered.status).toBe(200);
    const deliveredBody = (await delivered.json()) as { readonly events: readonly { readonly seq: number }[] };
    expect(deliveredBody.events).toHaveLength(1);
    const seq = deliveredBody.events[0]!.seq;
    expect((await harness.core.mailbox.readCursor(TENANT_A, device.deviceId)).ackedSeq).toBe(0);

    const response = await harness.request(byokInputPreparationCompletionPath(REQUEST_A), {
      method: 'PUT',
      headers: { ...device.authorization, 'content-type': 'application/json' },
      body: JSON.stringify(rejectedCompletion(REQUEST_A, reason)),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      tenantId: TENANT_A,
      deviceId: device.deviceId,
      requestId: REQUEST_A,
      agentRef: AGENT_A,
      status: 'rejected',
      reason,
    });

    // Durable, not just echoed back.
    await expect(
      harness.cloud.getInputPreparationStatus(TENANT_A, device.deviceId, { requestId: REQUEST_A, agentRef: AGENT_A }),
    ).resolves.toMatchObject({ status: 'rejected', reason });

    // And the cursor actually moves: the device ACKs the envelope it just
    // discharged, and the durable mailbox cursor is past it with nothing left.
    const acked = await harness.request(`/byok/events?cursor=${seq}`, { headers: device.authorization });
    expect(acked.status).toBe(200);
    expect(await acked.json()).toMatchObject({ cursor: seq, events: [] });
    expect((await harness.core.mailbox.readCursor(TENANT_A, device.deviceId)).ackedSeq).toBe(seq);
  });

  it('still binds a completion to the exact policy revision for a device without the flag', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await admitPreparation(harness, device.deviceId);
    await harness.cloud.enqueueInputPreparation(TENANT_A, device.deviceId, desired());
    await harness.stores.devices.recordCapabilities(TENANT_A, {
      deviceId: device.deviceId,
      capabilities: ['agent-home-contract'],
    });

    // Dropping the capability assertion did not turn the completion route into
    // an unauthenticated write: the row's own binding is still the authority.
    await expect(
      harness.request(byokInputPreparationCompletionPath(REQUEST_A), {
        method: 'PUT',
        headers: { ...device.authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ ...preparedCompletion(), policyRevision: 'limits-other' }),
      }),
    ).resolves.toMatchObject({ status: 422 });
    await expect(
      harness.cloud.getInputPreparationStatus(TENANT_A, device.deviceId, { requestId: REQUEST_A, agentRef: AGENT_A }),
    ).resolves.toMatchObject({ status: 'pending' });
  });
});
