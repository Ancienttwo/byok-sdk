import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { createByokServer, type ByokServer, type ByokServerEvent } from '../index';
import { connectFakeDaemonLongPoll, startServer, stopServer, type FakeLongPollDaemon } from './test-support';

const PRODUCT_ID = 'acme';
/** Short injected hold so a long-poll in this file never waits out the real ~50s default. */
const SHORT_HOLD_MS = 150;

/**
 * Collect every `device.rate_limited` event published up to (and including)
 * the point at which `barrierTaskId`'s `task.created` appears on the
 * cross-task feed.
 *
 * The barrier is a real, uniquely-identifiable server event rather than a
 * sleep: `AsyncEventQueue.subscribe()` (`event-queue.ts`) always replays from
 * the start of the retained buffer, and every rate-limit refusal is published
 * synchronously inside the `POST /byok/messages` request that caused it, so a
 * `dispatch()` awaited AFTER those requests have returned publishes a
 * `task.created` that is strictly later than all of them.
 */
async function rateLimitedEventsUpTo(byok: ByokServer, barrierTaskId: string): Promise<ByokServerEvent[]> {
  const seen: ByokServerEvent[] = [];
  for await (const event of byok.events.subscribe()) {
    if (event.kind === 'device.rate_limited') seen.push(event);
    if (event.kind === 'task.created' && event.taskId === barrierTaskId) return seen;
  }
  throw new Error('server event stream ended before the barrier task was seen');
}

/** One over-budget send: a claim for a task id nothing owns, which the gate debits at step 0 before it looks anything up. */
function floodEnvelope(daemon: FakeLongPollDaemon): Envelope {
  return createEnvelope('task.claim', { deviceId: daemon.deviceId }, { taskId: 'bogus-task-coalesce-2' });
}

describe('M4 Phase 4: rate-limit episode recovery', () => {
  let server: HttpServer | undefined;
  let byok: ByokServer | undefined;

  afterEach(async () => {
    byok?.stop();
    byok = undefined;
    if (server) await stopServer(server);
    server = undefined;
  });

  it('a NEW over-budget episode (after the device genuinely recovers under budget in between) gets its own fresh device.rate_limited event, not coalesced with the earlier one', async () => {
    // 1 token/s with a burst of 2: the fixture's own `conn.hello` spends one,
    // the first send below spends the other, and everything after that is over
    // budget until the bucket refills — no clock stubbing needed, and the
    // recovery below is driven by a real (bounded) admission poll rather than
    // a fixed sleep.
    const instance = createByokServer({
      productId: PRODUCT_ID,
      longPollHoldMs: SHORT_HOLD_MS,
      rateLimit: { messagesPerSecond: 1, burst: 2 },
    });
    byok = instance;
    const started = await startServer(instance);
    server = started.server;
    const daemon = await connectFakeDaemonLongPoll(started.baseUrl, instance, { productId: PRODUCT_ID });
    // The barrier the deleted `device.connected` event used to provide: the
    // device is present because its `conn.hello` was accepted, which
    // `machines.list()` reports directly.
    expect((await instance.machines.list()).map((machine) => machine.deviceId)).toEqual([daemon.deviceId]);

    const envelope = floodEnvelope(daemon);

    // Episode 1: the last burst token is spent, then two refusals — the first
    // opens the episode, the second is coalesced into it.
    expect((await daemon.send(envelope)).status).toBe(200);
    expect((await daemon.send(envelope)).status).toBe(429);
    expect((await daemon.send(envelope)).status).toBe(429);

    const episode1Barrier = await instance.dispatch({ deviceId: daemon.deviceId, instruction: 'episode-1 barrier' });
    expect(await rateLimitedEventsUpTo(instance, episode1Barrier.taskId)).toHaveLength(1);

    // Let the bucket refill (1 token/s) so the NEXT send genuinely succeeds,
    // clearing the coalescing suppression. Bounded poll on the wire's own
    // answer — never a fixed sleep, and every refusal it absorbs stays inside
    // episode 1.
    for (;;) {
      const attempt = await daemon.send(createEnvelope('task.claim', { deviceId: daemon.deviceId }, { taskId: 'bogus-task-recovery' }));
      if (attempt.status === 200) break;
      expect(attempt.status).toBe(429);
    }

    // Episode 2: flood again — a fresh, distinct embedder event.
    expect((await daemon.send(envelope)).status).toBe(429);
    expect((await daemon.send(envelope)).status).toBe(429);

    const episode2Barrier = await instance.dispatch({ deviceId: daemon.deviceId, instruction: 'episode-2 barrier' });
    expect(await rateLimitedEventsUpTo(instance, episode2Barrier.taskId)).toHaveLength(2);
  });
});
