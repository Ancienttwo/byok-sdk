import type { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { createEnvelope } from '@byok/protocol';
import { DeviceRegistry } from '../auth';
import { ConnectionHub } from '../hub';
import { RateLimiter } from '../rate-limiter';
import { InMemoryTaskStore } from '../task-store';

describe('M4 Phase 4: rate-limit episode recovery', () => {
  it('a NEW over-budget episode (after the device genuinely recovers under budget in between) gets its own fresh device.rate_limited event, not coalesced with the earlier one', async () => {
    const taskStore = new InMemoryTaskStore();
    // Fast refill (1000/s) + tiny burst (1) so the mutable clock can let the
    // device recover between the two flood episodes without a real-time sleep.
    const rateLimiter = new RateLimiter({ messagesPerSecond: 1000, burst: 1 });
    const hub = new ConnectionHub(taskStore, new DeviceRegistry(), 30 * 60_000, rateLimiter);
    try {
      const deviceId = 'device-coalesce-2';
      const fakeWs = { close: () => {}, send: () => {} } as unknown as WebSocket;
      hub.registerConnection(deviceId, fakeWs, undefined);

      const rateLimitedEvents: unknown[] = [];
      const serverEvents = hub.subscribeServerEvents()[Symbol.asyncIterator]();
      const nextServerEvent = async () => {
        let timer!: ReturnType<typeof setTimeout>;
        try {
          return await Promise.race([
            serverEvents.next(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('timed out waiting for server event')), 1000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      };
      const drainThroughBarrier = async (barrierDeviceId: string): Promise<void> => {
        for (;;) {
          const event = await nextServerEvent();
          if (event.done) throw new Error(`server event stream closed before barrier ${barrierDeviceId}`);
          if (event.value.kind === 'device.rate_limited') rateLimitedEvents.push(event.value);
          if (event.value.kind === 'device.connected' && event.value.deviceId === barrierDeviceId) return;
        }
      };

      const envelope = createEnvelope('task.claim', { deviceId }, { taskId: 'bogus-task-coalesce-2' });

      const originalDateNow = Date.now;
      let nowMs = originalDateNow();
      try {
        Date.now = () => nowMs;

        // Episode 1: burst=1, so call #1 succeeds and call #2 floods.
        hub.handleInbound(deviceId, envelope);
        hub.handleInbound(deviceId, envelope);
        const episode1Barrier = 'device-coalesce-2-episode-1-barrier';
        hub.registerConnection(episode1Barrier, fakeWs, undefined);
        await drainThroughBarrier(episode1Barrier);
        expect(rateLimitedEvents).toHaveLength(1);

        // Let the bucket refill (1000/s — a few ms is plenty) so the NEXT
        // call genuinely succeeds, clearing the coalescing suppression.
        nowMs += 20;
        hub.handleInbound(deviceId, envelope); // succeeds — back under budget

        // Episode 2: flood again — a fresh, distinct embedder event.
        hub.handleInbound(deviceId, envelope);
        hub.handleInbound(deviceId, envelope);
        const episode2Barrier = 'device-coalesce-2-episode-2-barrier';
        hub.registerConnection(episode2Barrier, fakeWs, undefined);
        await drainThroughBarrier(episode2Barrier);
        expect(rateLimitedEvents).toHaveLength(2);
      } finally {
        Date.now = originalDateNow;
      }
    } finally {
      hub.stopLeaseReaper();
    }
  });
});
