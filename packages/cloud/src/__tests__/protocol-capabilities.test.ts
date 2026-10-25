/**
 * The protocol capability advertisement a long-poll daemon negotiates against.
 *
 * On the deleted reference server this list reached the daemon two ways: the WS
 * `conn.ack` and the long-poll response body, both carrying `CAPABILITY_FLAGS`
 * wholesale (`packages/server/src/http.ts:382` on `origin/main`). The WP3B
 * façade serves no WS upgrade, so `GET /byok/events` is now the ONLY channel —
 * and the daemon hard-gates real wire behavior on what it finds there
 * (`packages/client/src/daemon/task-runner.ts:3319,3849`,
 * `packages/client/src/daemon/agent-egress-controller.ts:122,285`). A flag
 * dropped from the kernel's declaration is therefore a silently disabled
 * protocol path, not a cosmetic difference — which is exactly how
 * `approval_resolved` went missing.
 *
 * So the list is pinned exactly rather than by `toContain`: any future edit to
 * `CLOUD_PROTOCOL_CAPABILITIES` shows up here as a visible diff that has to be
 * justified against the kernel's inbound, in both directions (a removal breaks
 * a daemon path; an addition promises acceptance the kernel may not implement).
 */
import { createEnvelope, PROTOCOL_VERSION, type MessagesSendResponse } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { TENANT_A, createHarness, decodeEventsPage, offerPayload } from './support/harness';

/**
 * The exact advertisement, in declaration order
 * (`packages/cloud/src/handlers/events.ts:35`). Keep this literal — deriving it
 * from the source under test would assert nothing.
 */
const EXPECTED_CAPABILITIES = [
  'custom-harness',
  'mailbox-read-ahead',
  'approval_resolved', 'agent-message-draft',
  'agent-home-contract',
  'agent-home-projection',
  'agent-egress-policy',
  'agent-egress-reliable-ack',
  'agent-egress-fresh-session',
  'agent-message-egress',
  'agent-content-workspace-read',
  'agent-content-transcript-read',
  'agent-content-artifact-read',
  'sealed-payload-v1',
  'sealed-output-ciphertext-ref',
  'runtime-failure-class',
];

describe('GET /byok/events protocol capability advertisement', () => {
  it('serves the exact declared list on the empty-page path', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);

    const poll = await harness.json('/byok/events?cursor=0', { headers: device.authorization });

    expect(poll.status).toBe(200);
    expect(decodeEventsPage(poll.body).capabilities).toEqual(EXPECTED_CAPABILITIES);
  });

  it('serves the same list on the delivered-page path', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const offer = await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, {
      payload: offerPayload(),
    });

    const poll = await harness.json('/byok/events?cursor=0', { headers: device.authorization });

    expect(poll.status).toBe(200);
    const body = decodeEventsPage(poll.body);
    expect(body.events.map((event) => event.seq)).toEqual([offer.seq]);
    // A daemon that only ever sees non-empty polls must negotiate the same
    // contract as one that only ever sees empty ones.
    expect(body.capabilities).toEqual(EXPECTED_CAPABILITIES);
  });

  it('serves the same list on the answer to an accepted conn.hello, and only there (#391 Phase 2)', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    const post = (messages: unknown[]) =>
      harness.json('/byok/messages', {
        method: 'POST',
        headers: { ...device.authorization, 'content-type': 'application/json' },
        body: JSON.stringify({ messages }),
      });
    const hello = (protocolVersions: number[]) =>
      createEnvelope('conn.hello', {
        protocolVersions,
        capabilities: [],
        deviceId: device.deviceId,
        productId: 'test-product',
      });

    // The handshake answer is how a device learns the advertisement without
    // waiting out a held poll.
    const handshake = await post([hello([PROTOCOL_VERSION])]);
    expect(handshake.status).toBe(200);
    expect(handshake.body as MessagesSendResponse).toMatchObject({ accepted: 1, capabilities: EXPECTED_CAPABILITIES });

    // A batch without a hello carries no update: absence, never an empty list.
    const other = await post([createEnvelope('task.started', {}, { taskId: 'no-such-task' })]);
    expect(other.status).toBe(200);
    expect(Object.hasOwn(other.body as object, 'capabilities')).toBe(false);

    // A rejected hello opens nothing, so it advertises nothing. A v2-only
    // daemon is refused here: wire v3 has no v2 reader.
    const refused = await post([hello([2])]);
    expect(refused.status).toBe(200);
    expect(refused.body as MessagesSendResponse).toMatchObject({ accepted: 0, rejected: 1 });
  });

  it('advertises approval_resolved, which the kernel inbound accepts', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);

    const poll = await harness.json('/byok/events?cursor=0', { headers: device.authorization });

    // Pinned on its own because this one is load-bearing for a whole daemon
    // path: `TaskRunner.sendApprovalResolved` returns early without it, so a
    // locally-resolved approval is never reported at all and the server is left
    // to infer the resume. `packages/cloud/src/inbound.ts:576,610` handles the
    // message the flag unlocks.
    expect(decodeEventsPage(poll.body).capabilities).toContain('approval_resolved');
  });

  it('keeps protocol flags off the deployment declaration route', async () => {
    const harness = createHarness();

    const declaration = await harness.json('/byok/capabilities');

    // `GET /byok/capabilities` is the deployment composition declaration
    // (ADR-010) and is served unauthenticated; the protocol negotiation is a
    // device-scoped fact on the poll response. Conflating the two would leak
    // per-transport protocol state onto a public route.
    expect(declaration.status).toBe(200);
    const body = declaration.body as { readonly schema: string; readonly capabilities: readonly string[] };
    expect(body.schema).toBe('byok-capabilities-v1');
    for (const flag of EXPECTED_CAPABILITIES) {
      expect(body.capabilities).not.toContain(flag);
    }
  });
});
