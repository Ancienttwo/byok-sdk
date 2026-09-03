import { createHash } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { createByokServer, type ByokServer, type TokenSigner } from '../index';
import {
  connectFakeDaemonLongPoll,
  nextEnvelope,
  pairFakeDaemon,
  sendOne,
  startServer,
  stopServer,
  testPairingClaims,
} from './test-support';

const PRODUCT_ID = 'acme';
const AGENT_REF = { agentId: 'agent-issues', profileRevision: 'profile-r1' } as const;
const CONTENT_HASH = 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
/** Short enough that a poll deliberately expecting nothing costs ~200ms, not ~50s. */
const SHORT_HOLD_MS = 200;

function sha256Hex(data: Buffer): string {
  return `sha256:${createHash('sha256').update(data).digest('hex')}`;
}

describe('Issues #112/#114/#115/#116/#117/#118/#120 reference-server regressions', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;

  afterEach(async () => {
    byok?.stop();
    byok = undefined;
    if (server) await stopServer(server);
    server = undefined;
  });

  async function start(
    opts: Partial<Parameters<typeof createByokServer>[0]> = {},
  ): Promise<{ byok: ByokServer; baseUrl: string }> {
    const instance = createByokServer({ productId: PRODUCT_ID, longPollHoldMs: SHORT_HOLD_MS, ...opts });
    const started = await startServer(instance);
    server = started.server;
    byok = instance;
    return { byok: instance, baseUrl: started.baseUrl };
  }

  it('#112 retries one immutable pairing completion after token issuance fails', async () => {
    let signCalls = 0;
    const signer: TokenSigner = {
      async sign() {
        signCalls++;
        if (signCalls === 1) throw new Error('injected first token signing failure');
        return 'retry-token';
      },
      async verify() {
        return undefined;
      },
    };
    const started = await start({ tokenSigner: signer });
    const { code } = await started.byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const publicKey = 'A'.repeat(43);
    const request = {
      pairingCode: code,
      deviceName: 'retryable-first-pair',
      devicePublicKey: publicKey,
    };

    const first = await fetch(`${started.baseUrl}/byok/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    });
    expect(first.status).toBeGreaterThanOrEqual(500);

    const retry = await fetch(`${started.baseUrl}/byok/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    });
    expect(retry.status).toBe(200);
    const recovered = await retry.json() as { deviceId: string; accessToken: string; tenantId: string };
    expect(recovered.accessToken).toBe('retry-token');
    // The tenant is no longer a fixture-authored claim (one embedded server,
    // one derived tenant), so what is pinned here is that the recovered
    // completion names a real enrollment tenant and keeps naming the SAME one
    // on every later retry — see the `afterLostResponse` check below.
    expect(recovered.tenantId).toBeTruthy();
    expect(await started.byok.machines.list()).toHaveLength(1);

    // The response body of this successful completion is intentionally not
    // consumed. Its exact retry must still name the same enrollment.
    await fetch(`${started.baseUrl}/byok/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    });
    const afterLostResponse = await fetch(`${started.baseUrl}/byok/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    });
    expect(afterLostResponse.status).toBe(200);
    const replayed = await afterLostResponse.json() as { deviceId: string; tenantId: string };
    expect(replayed.deviceId).toBe(recovered.deviceId);
    expect(replayed.tenantId).toBe(recovered.tenantId);

    // A re-redemption of the same code under a DIFFERENT device key is refused
    // and changes nothing. The reference server answered 409; the kernel
    // deliberately collapses unknown / expired / already-used into one 401 with
    // one message (`packages/cloud/src/handlers/auth.ts` header) so a pairing
    // code cannot become an oracle — a narrowing, and the status is re-pinned
    // to it here. What #112 is actually about, immutability of the completion,
    // is asserted straight after: the original key still names the original
    // enrollment.
    const conflict = await fetch(`${started.baseUrl}/byok/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...request, devicePublicKey: 'B'.repeat(43) }),
    });
    expect(conflict.status).toBe(401);
    const unchanged = await fetch(`${started.baseUrl}/byok/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    });
    expect(unchanged.status).toBe(200);
    expect((await unchanged.json() as { deviceId: string }).deviceId).toBe(recovered.deviceId);

    const concurrentCode = (await started.byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID))).code;
    const concurrentRequest = { ...request, pairingCode: concurrentCode, deviceName: 'concurrent-first-pair' };
    const concurrent = await Promise.all([
      fetch(`${started.baseUrl}/byok/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(concurrentRequest) }),
      fetch(`${started.baseUrl}/byok/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(concurrentRequest) }),
    ]);
    expect(concurrent.map((response) => response.status)).toEqual([200, 200]);
    const concurrentResponses = await Promise.all(concurrent.map(async (response) => response.json() as Promise<{ deviceId: string }>));
    expect(concurrentResponses[0]?.deviceId).toBe(concurrentResponses[1]?.deviceId);
    expect(await started.byok.machines.list()).toHaveLength(2);
  });

  it('#114 refuses an over-reservation Content-Length before the upload body reaches a store write', async () => {
    const started = await start({ maxBlobSizeBytes: 32 });
    const { code } = await started.byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const { accessToken } = await pairFakeDaemon(started.baseUrl, code);
    const declared = Buffer.from('abc');
    const created = await fetch(`${started.baseUrl}/byok/blobs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', 'idempotency-key': 'bounded-upload' },
      body: JSON.stringify({ size: declared.length, contentType: 'text/plain', contentHash: sha256Hex(declared) }),
    });
    const { uploadUrl } = (await created.json()) as { uploadUrl: string };
    const oversized = await fetch(`${started.baseUrl}${uploadUrl}`, {
      method: 'PUT',
      headers: { 'content-length': '4' },
      body: Buffer.from('abcd'),
    });
    expect(oversized.status).toBe(413);
  });

  it('#114 stops a chunked upload at the reservation plus one byte when Content-Length is absent', async () => {
    const started = await start({ maxBlobSizeBytes: 32 });
    const { code } = await started.byok.pairing.createPairingCode(testPairingClaims(PRODUCT_ID));
    const { accessToken } = await pairFakeDaemon(started.baseUrl, code);
    const declared = Buffer.from('abc');
    const created = await fetch(`${started.baseUrl}/byok/blobs`, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', 'idempotency-key': 'chunked-bounded-upload' },
      body: JSON.stringify({ size: declared.length, contentType: 'text/plain', contentHash: sha256Hex(declared) }),
    });
    const { uploadUrl } = (await created.json()) as { uploadUrl: string };
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('abc'));
        controller.enqueue(Buffer.from('d'));
        controller.close();
      },
    });
    const oversized = await fetch(`${started.baseUrl}${uploadUrl}`, {
      method: 'PUT',
      body: stream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    expect(oversized.status).toBe(413);
  });

  // 2d gap: this reserved an upload URL against a blob store constructed OUTSIDE
  // the server (`new LocalDiskBlobStore()` + `CreateByokServerOptions.blobStore`)
  // and then mounted a server whose ceiling was lower than the reservation. Both
  // the class and the option are deleted (WP3B 2b — blob storage is the kernel's
  // composition now), and a running instance's `maxBlobSizeBytes` cannot be
  // changed, so a URL reserved above the current ceiling cannot be produced from
  // the public surface. The absolute-ceiling check itself is still live code
  // (`blobUploadContentHandler`, `expectedBytes > absoluteCeiling`); the two
  // #114 cases above cover the declared-size half of it.
  it.skip('#114 enforces the deployment ceiling even for a previously-reserved capability URL', () => {
    // intentionally empty — see the 2d gap note above.
  });

  // 2d gap: needs TWO tenants on one instance, and an embedded server has
  // exactly one (`createPairingCode` no longer takes a tenant), so a "foreign"
  // blob id cannot be addressed by a device of another tenant here. Its second
  // half drove `LocalDiskBlobStore`/`SqliteBlobStore` directly, both deleted in
  // 2b. Tenant-scoped blob ownership — including that an unknown and a foreign
  // id are indistinguishable — is covered at the port level by
  // `packages/conformance/src/cloud/blobs.ts`.
  it.skip('#115 makes a disclosed foreign blob id indistinguishable from missing at the URL-mint boundary', () => {
    // intentionally empty — see the 2d gap note above.
  });

  it('#116 returns an explicit long-poll replay-gap failure instead of a normal partial tail', async () => {
    const started = await start();
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, { productId: PRODUCT_ID });

    const owed = await started.byok.dispatch({ deviceId: daemon.deviceId, instruction: 'never acked' });
    // Read it (reading does not ack) so the row is genuinely undelivered work,
    // then retire it: the recoverable floor moves ONLY on expiry, never on
    // volume — the count-bounded replay ring that used to move it is deleted,
    // not rebuilt (WP3B Step 0 case 7, packet §5 item 7).
    expect((await daemon.replay(0)).status).toBe(200);
    const swept = await started.byok.mailbox.collectRetired({
      deviceId: daemon.deviceId,
      ackedBefore: '2999-01-01T00:00:00.000Z',
      expireUnackedBefore: '2999-01-01T00:00:00.000Z',
    });
    expect(swept.expiredCount).toBe(1);
    expect(owed.taskId).toBeTruthy();

    const response = await daemon.replay(0);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: 'cursor_too_old', recoverableFrom: expect.any(Number) });
  });

  it('#120 rejects a first agent message publish after cancellation without calling the product consumer', async () => {
    const consumed: unknown[] = [];
    const started = await start({
      agentMessage: {
        async consume(input) {
          consumed.push(input);
          return { outcome: 'accepted' };
        },
      },
    });
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, started.byok, {
      productId: PRODUCT_ID,
      capabilities: [
        'agent-home-contract',
        'agent-egress-policy',
        'agent-egress-reliable-ack',
        'agent-message-egress',
        'terminal-projection-selection',
      ],
    });
    const task = await started.byok.dispatch({
      deviceId: daemon.deviceId,
      instruction: 'late publish must not side effect',
      agentRef: AGENT_REF,
      sessionRef: 'session-issues',
      egressPolicy: {
        policyRevision: 'policy-r1',
        activity: { mode: 'metadata-status', delivery: 'latest-value' },
        reliable: { maxPendingEventsPerAgent: 1, maxPendingBytesPerAgent: 1024, maxPendingBytesPerTenant: 1024 },
        transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' },
      },
      messageEgress: { mode: 'required', contract: 'example.chat.v1', contentType: 'text/markdown', maxBytes: 1024 },
      terminalProjection: { mode: 'none' },
      agentMessageContext: { destinationBinding: 'conversation/issue-120' },
    });
    expect((await nextEnvelope(daemon)).type).toBe('task.offer_for_agent_with_egress');
    await task.cancel('cancel before first publish');
    expect((await nextEnvelope(daemon)).type).toBe('task.cancel');

    // The `POST /byok/messages` response IS the barrier: the kernel applies
    // (or refuses) the envelope inside the request, so once this resolves the
    // consumer has either been called or provably never will be for it.
    const published = await sendOne(
      daemon,
      createEnvelope(
        'agent.message.publish',
        {
          agentRef: AGENT_REF,
          sessionRef: 'session-issues',
          contract: 'example.chat.v1',
          messageId: '10000000-0000-4000-8000-000000000120',
          cursor: 1,
          contentType: 'text/markdown',
          body: 'hello',
          contentHash: CONTENT_HASH,
          byteCount: 5,
        },
        { taskId: task.taskId },
      ),
    );
    expect(published.status).toBe(200);
    expect(consumed).toHaveLength(0);
  });
});
