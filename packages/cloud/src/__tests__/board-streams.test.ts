import { createMutableClock } from '@byok/core';
import { createEnvelope } from '@byok/protocol';
import { describe, expect, it } from 'vitest';
import { CLOUD_CAPABILITIES, fullCapabilityDeclaration } from '../capabilities';
import { BoardFeedClient, BoardFeedRetryableError } from '../coordination-client';
import { createHarness, TENANT_A, TENANT_B, type CloudHarness, type PairedDevice } from './support/harness';

function jsonInit(device: PairedDevice, body: unknown, method = 'POST'): RequestInit {
  return {
    method,
    headers: { ...device.authorization, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
  timeoutMs = 500,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';
  const deadline = performance.now() + timeoutMs;
  while (!predicate(text)) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error(`timed out reading SSE: ${text}`);
    const result = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`timed out reading SSE: ${text}`)), remaining),
      ),
    ]);
    if (result.done) break;
    text += decoder.decode(result.value, { stream: true });
  }
  return text;
}

async function createBoardFixture(harness: CloudHarness, itemId: string, tenant = TENANT_A) {
  return harness.cloud.createBoardItem(tenant, {
    itemId,
    channel: 'support',
    title: `Work item ${itemId}`,
  });
}

describe('board coordination surface', () => {
  it('polls incrementally and keeps per-tenant sequence/rows isolated (I6)', async () => {
    const harness = createHarness();
    const alice = await harness.pairDevice(TENANT_A);
    await harness.pairDevice(TENANT_B);
    const a1 = await createBoardFixture(harness, 'a-1', TENANT_A);
    const b1 = await createBoardFixture(harness, 'b-1', TENANT_B);
    await createBoardFixture(harness, 'b-2', TENANT_B);

    expect(a1.boardSeq).toBe(1);
    expect(b1.boardSeq).toBe(1);
    const first = await harness.json('/byok/board?since=0', { headers: alice.authorization });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ nextSeq: 1, hasMore: false });
    expect(JSON.stringify(first.body)).toContain('a-1');
    expect(JSON.stringify(first.body)).not.toContain('b-1');

    const unchanged = await harness.json('/byok/board?since=1', { headers: alice.authorization });
    expect(unchanged.body).toEqual({ items: [], nextSeq: 1, hasMore: false });
  });

  it('admits exactly one of 100 device claims and returns the winner snapshot to every loser', async () => {
    const harness = createHarness();
    await createBoardFixture(harness, 'race');
    // Seed the shared entitlement once before parallel pairing. The quota CAS
    // is intentionally strict and is not what this claim race is measuring.
    const firstDevice = await harness.pairDevice(TENANT_A);
    const devices = [
      firstDevice,
      ...(await Promise.all(Array.from({ length: 99 }, () => harness.pairDevice(TENANT_A)))),
    ];
    const responses = await Promise.all(
      devices.map((device) =>
        harness.json('/byok/board/race/claim', jsonInit(device, { expectedStatus: 'todo' })),
      ),
    );
    const winners = responses.filter((response) => response.status === 200);
    const losers = responses.filter((response) => response.status === 409);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(99);
    const winnerId = (winners[0]!.body as { assignee: { holderId: string } }).assignee.holderId;
    for (const loser of losers) {
      expect(loser.body).toMatchObject({
        error: 'board_claim_conflict',
        current: { assignee: { holderId: winnerId } },
        holder: { holderId: winnerId },
      });
      expect((loser.body as { observedAt: unknown }).observedAt).toBeTypeOf('string');
    }
  });

  it('returns current status on CAS miss and reserves done for host review acceptance', async () => {
    const harness = createHarness();
    const device = await harness.pairDevice(TENANT_A);
    await createBoardFixture(harness, 'review');
    expect(
      (await harness.json('/byok/board/review/claim', jsonInit(device, { expectedStatus: 'todo' }))).status,
    ).toBe(200);

    const stale = await harness.json(
      '/byok/board/review/status',
      jsonInit(device, { expectedStatus: 'todo', status: 'in_review' }),
    );
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({
      error: 'board_status_conflict',
      current: { status: 'in_progress' },
    });

    const reviewed = await harness.json(
      '/byok/board/review/status',
      jsonInit(device, { expectedStatus: 'in_progress', status: 'in_review' }),
    );
    expect(reviewed.status).toBe(200);
    expect((reviewed.body as { status: string }).status).toBe('in_review');
    expect(
      (
        await harness.json(
          '/byok/board/review/status',
          jsonInit(device, { expectedStatus: 'in_review', status: 'done' }),
        )
      ).status,
    ).toBe(403);
    expect((await harness.cloud.acceptBoardItem(TENANT_A, 'review')).status).toBe('done');
  });

  it('projects the first wire terminal to at most in_review and stores progress via the batch seam', async () => {
    const harness = createHarness({ activityCapacity: 2 });
    const device = await harness.pairDevice(TENANT_A);
    await createBoardFixture(harness, 'projected');
    await harness.cloud.enqueueOffer(TENANT_A, device.deviceId, {
      taskId: 'projected',
      payload: { instruction: 'explicit instruction', policy: { mode: 'auto' } },
    });
    await harness.json('/byok/board/projected/claim', jsonInit(device, { expectedStatus: 'todo' }));

    const claim = createEnvelope('task.claim', { deviceId: device.deviceId }, { taskId: 'projected' });
    const progress = createEnvelope(
      'task.progress',
      {
        seq: 1,
        events: [
          { type: 'progress', text: 'one' },
          { type: 'progress', text: 'two' },
          { type: 'turn_end' },
        ],
      },
      { taskId: 'projected' },
    );
    const complete = createEnvelope(
      'task.complete',
      { summary: 'complete', sessionRef: 'session-1' },
      { taskId: 'projected' },
    );
    const sent = await harness.json('/byok/messages', jsonInit(device, { messages: [claim, progress, complete] }));
    expect(sent).toEqual({ status: 200, body: { accepted: 3 } });

    expect((await harness.cloud.listBoardItems(TENANT_A, { afterSeq: 0 })).items[0]!.status).toBe(
      'in_review',
    );
    const activity = await harness.cloud.readActivity(TENANT_A, 'projected');
    expect(activity?.entries).toHaveLength(2);
    expect(activity?.dropped).toBe(1);
    expect(activity?.entries.map((entry) => JSON.parse(entry.detail).type)).toEqual([
      'progress',
      'turn_end',
    ]);
  });

  it('bounds producer labels, presence cadence/detail, and activity events/bytes', async () => {
    const clock = createMutableClock();
    const harness = createHarness({
      clock,
      boardTitleMaxBytes: 4,
      presenceMinimumIntervalMs: 5_000,
      presenceDetailMaxBytes: 4,
      activityMaxEvents: 2,
      activityMaxBytes: 64,
      activityCapacity: 2,
    });
    const device = await harness.pairDevice(TENANT_A);
    expect(() =>
      harness.cloud.createBoardItem(TENANT_A, {
        itemId: 'oversized',
        channel: 'x',
        title: '12345',
      }),
    ).toThrowError(expect.objectContaining({ code: 'coordination_input_invalid' }));

    expect(
      (
        await harness.json(
          '/byok/presence',
          jsonInit(device, { level: 'online', detail: 'okay' }, 'PUT'),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await harness.json(
          '/byok/presence',
          jsonInit(device, { level: 'working', detail: 'okay' }, 'PUT'),
        )
      ).status,
    ).toBe(429);
    clock.advance(5_000);
    expect(
      (
        await harness.json(
          '/byok/presence',
          jsonInit(device, { level: 'working', detail: 'toolong' }, 'PUT'),
        )
      ).status,
    ).toBe(413);

    const tooMany = await harness.json(
      '/byok/activity',
      jsonInit(device, {
        taskId: 'activity',
        events: [
          { type: 'turn_end' },
          { type: 'turn_end' },
          { type: 'turn_end' },
        ],
        dropped: 0,
      }),
    );
    expect(tooMany).toEqual({ status: 413, body: { error: 'activity_batch_too_large' } });
  });
});

describe('board SSE/poll parity', () => {
  for (const mode of ['poll', 'sse'] as const) {
    it(`passes the shared current-snapshot and tenant-isolation behavior through ${mode}`, async () => {
      const harness = createHarness({ boardStreamQueryIntervalMs: 5 });
      const alice = await harness.pairDevice(TENANT_A);
      await harness.pairDevice(TENANT_B);
      await createBoardFixture(harness, `shared-${mode}`, TENANT_A);
      await createBoardFixture(harness, `foreign-${mode}`, TENANT_B);

      if (mode === 'poll') {
        const response = await harness.json('/byok/board?since=0', { headers: alice.authorization });
        expect(response.body).toMatchObject({
          items: [{ itemId: `shared-${mode}`, tenantId: TENANT_A }],
        });
        expect(JSON.stringify(response.body)).not.toContain(`foreign-${mode}`);
        return;
      }

      const abort = new AbortController();
      const response = await harness.request('/byok/board/stream', {
        headers: alice.authorization,
        signal: abort.signal,
      });
      const reader = response.body!.getReader();
      const text = await readUntil(reader, (value) => value.includes(`shared-${mode}`));
      expect(text).toContain(`shared-${mode}`);
      expect(text).not.toContain(`foreign-${mode}`);
      abort.abort();
    });
  }

  it('uses Last-Event-ID, emits heartbeats/reconcile, and repairs a dropped consumer update by full poll', async () => {
    const harness = createHarness({
      boardStreamQueryIntervalMs: 5,
      boardStreamHeartbeatIntervalMs: 10,
      boardStreamReconciliationIntervalMs: 15,
    });
    const device = await harness.pairDevice(TENANT_A);
    const first = await createBoardFixture(harness, 'streamed');
    const abort = new AbortController();
    const response = await harness.request('/byok/board/stream', {
      headers: device.authorization,
      signal: abort.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const initial = await readUntil(reader, (text) => text.includes(`id: ${first.boardSeq}`));
    expect(initial).toContain('event: board');

    await harness.json('/byok/board/streamed/claim', jsonInit(device, { expectedStatus: 'todo' }));
    // The consumer intentionally ignores the incremental update. Reconcile is
    // a signal to run the same first-class full poll, which repairs its view.
    const control = await readUntil(
      reader,
      (text) => text.includes('event: reconcile') && text.includes(': heartbeat'),
    );
    expect(control).toContain('event: reconcile');
    const repaired = await harness.json('/byok/board?since=0', { headers: device.authorization });
    expect(repaired.body).toMatchObject({ items: [{ itemId: 'streamed', status: 'in_progress' }] });
    abort.abort();

    const resumed = await harness.request('/byok/board/stream', {
      headers: { ...device.authorization, 'last-event-id': String(first.boardSeq) },
      signal: new AbortController().signal,
    });
    const resumedReader = resumed.body!.getReader();
    expect(await readUntil(resumedReader, (text) => text.includes('status":"in_progress'))).toContain(
      'event: board',
    );
    await resumedReader.cancel();
  });

  it('rejects ambiguous cursors and stops after credential revocation', async () => {
    const harness = createHarness({ boardStreamQueryIntervalMs: 5 });
    const device = await harness.pairDevice(TENANT_A);
    const conflict = await harness.request('/byok/board/stream?since=1', {
      headers: { ...device.authorization, 'last-event-id': '2' },
    });
    expect(conflict.status).toBe(400);

    const response = await harness.request('/byok/board/stream', { headers: device.authorization });
    const reader = response.body!.getReader();
    await harness.cloud.revokeDevice(TENANT_A, device.deviceId);
    const ended = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('stream did not stop')), 250)),
    ]);
    expect(ended.done).toBe(true);
  });

  it('mounts polling without SSE only by explicit declaration, never by status sniffing', () => {
    const capabilities = {
      ...fullCapabilityDeclaration(),
      capabilities: fullCapabilityDeclaration().capabilities.filter(
        (capability) => capability !== CLOUD_CAPABILITIES.boardSse,
      ),
    };
    const harness = createHarness({ capabilities });
    expect(harness.cloud.routes.some((route) => route.path === '/byok/board')).toBe(true);
    expect(harness.cloud.routes.some((route) => route.path === '/byok/board/stream')).toBe(false);
  });
});

describe('BoardFeedClient declaration and retry behavior', () => {
  const item = {
    tenantId: 'tenant-a',
    itemId: 'client-item',
    channel: 'ops',
    title: 'Client item',
    status: 'todo',
    boardSeq: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as const;

  it('uses first-class poll only when the declaration omits board.sse', async () => {
    const capabilities = {
      ...fullCapabilityDeclaration(),
      capabilities: fullCapabilityDeclaration().capabilities.filter(
        (capability) => capability !== CLOUD_CAPABILITIES.boardSse,
      ),
    };
    const seen: string[] = [];
    const client = new BoardFeedClient({
      baseUrl: 'https://cloud.test',
      accessToken: 'token',
      capabilities,
      fetch: (async (input) => {
        seen.push(String(input));
        return Response.json({ items: [item], nextSeq: 1, hasMore: false });
      }) as typeof fetch,
    });
    expect(client.mode).toBe('poll');
    expect(await client.readOnce(0)).toEqual({
      type: 'poll',
      page: { items: [item], nextSeq: 1, hasMore: false },
    });
    expect(seen[0]).toContain('/byok/board?since=0');
  });

  it('retries temporary SSE 5xx as SSE and never mutates into polling', async () => {
    let calls = 0;
    const client = new BoardFeedClient({
      baseUrl: 'https://cloud.test',
      accessToken: 'token',
      capabilities: fullCapabilityDeclaration(),
      fetch: (async () => {
        calls += 1;
        if (calls === 1) return new Response('temporary', { status: 503 });
        return new Response(`event: board\nid: 1\ndata: ${JSON.stringify(item)}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        });
      }) as typeof fetch,
    });
    await expect(client.readOnce(0)).rejects.toBeInstanceOf(BoardFeedRetryableError);
    expect(client.mode).toBe('sse');
    expect(await client.readOnce(0)).toEqual({ type: 'board', item });
    expect(client.mode).toBe('sse');
  });

  it('turns an idle SSE into a retryable watchdog failure without downgrading', async () => {
    const client = new BoardFeedClient({
      baseUrl: 'https://cloud.test',
      accessToken: 'token',
      capabilities: fullCapabilityDeclaration(),
      idleWatchdogMs: 5,
      fetch: (async () =>
        new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          headers: { 'content-type': 'text/event-stream' },
        })) as typeof fetch,
    });
    await expect(client.readOnce(0)).rejects.toBeInstanceOf(BoardFeedRetryableError);
    expect(client.mode).toBe('sse');
  });
});
