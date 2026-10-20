import { afterEach, describe, expect, it } from 'vitest';
import type { ChannelPort, Delivery } from './channel';

/** An adapter supplies its controllable transport and a real Host fixture. No kernel or ledger substitute is allowed. */
export interface ChannelContractHarness {
  publish(): Promise<void>;
  drain(): Promise<void>;
  advance(ms: number): Promise<void>;
  deliveries(): Delivery[];
  close(): Promise<void>;
}
/**
 * Reusable Host-facing ChannelPort contract. `open` installs the given external transport.
 * Adapter suites can wrap that transport in their adapter and reuse the same observable cases.
 * The fixture uses a short configured business deadline, without changing any test deadline.
 */
export function channelContract(name: string, open: (port: ChannelPort) => Promise<ChannelContractHarness>): void {
  describe(name, () => {
    let harness: ChannelContractHarness | undefined;
    afterEach(async () => { await harness?.close(); harness = undefined; });
    it('accepts once and never repeats a final delivery across concurrent drains', async () => {
      const sent: string[] = [];
      harness = await open({ send: async input => { sent.push(input.deliveryId); return { result: 'accepted', platformMessageId: 'p1' }; } });
      await harness.publish();
      await Promise.all([harness.drain(), harness.drain(), harness.drain()]);
      expect(harness.deliveries()).toEqual([expect.objectContaining({ state: 'accepted', attempts: 1, platformMessageId: 'p1' })]);
      expect(sent).toEqual([harness.deliveries()[0]!.id]);
    });
    it.each(['exception', 'deadline'] as const)('%s leaves unknown and never blindly sends twice', async cause => {
      let calls = 0;
      let signal: AbortSignal | undefined;
      harness = await open({ send: async (_input, current) => {
        calls++; signal = current;
        if (cause === 'exception') throw new Error('connection lost after write');
        return new Promise<never>(() => {});
      } });
      await harness.publish(); await harness.drain();
      expect(harness.deliveries()).toEqual([expect.objectContaining({ state: 'unknown', attempts: 1, code: cause === 'deadline' ? 'send_timeout' : 'send_failed' })]);
      if (cause === 'deadline') expect(signal?.aborted).toBe(true);
      await harness.advance(60_000); await harness.drain();
      expect(calls).toBe(1);
    });
    it('respects Retry-After and rejects the third retryable refusal', async () => {
      let calls = 0;
      harness = await open({ send: async () => { calls++; return { result: 'rejected', code: '429', retryable: true, retryAfterMs: 5_000 }; } });
      await harness.publish(); await harness.drain();
      expect(harness.deliveries()[0]).toMatchObject({ state: 'pending', attempts: 1 });
      await harness.advance(4_999); expect(calls).toBe(1);
      await harness.advance(1); expect(calls).toBe(2);
      await harness.advance(4_999); expect(calls).toBe(2);
      await harness.advance(1); expect(calls).toBe(3);
      expect(harness.deliveries()[0]).toMatchObject({ state: 'rejected', attempts: 3, code: '429' });
      await harness.advance(60_000); expect(calls).toBe(3);
    });
    it.each([
      { code: 'permission_denied', retryable: false },
      { code: '429', retryable: true, retryAfterMs: 60_001 },
    ])('permanently rejects $code with retryable=$retryable', async rejection => {
      let calls = 0;
      harness = await open({ send: async () => { calls++; return { result: 'rejected', ...rejection }; } });
      await harness.publish(); await harness.drain();
      expect(harness.deliveries()[0]).toMatchObject({ state: 'rejected', attempts: 1, code: rejection.code });
      await harness.advance(120_000); expect(calls).toBe(1);
    });
    it.each(['accepted', 'absent', 'unsupported'] as const)('reconciles unknown from authoritative readback %s', async result => {
      let calls = 0;
      const read: string[] = [];
      harness = await open({ send: async () => { calls++; if (calls === 1) throw new Error('lost receipt'); return { result: 'accepted', platformMessageId: 'p2' }; },
        readback: async id => { read.push(id); return result; } });
      await harness.publish(); await harness.drain();
      const row = harness.deliveries()[0]!;
      expect(read.length).toBeGreaterThan(0);
      expect(new Set(read)).toEqual(new Set([row.id]));
      expect(row.state).toBe(result === 'accepted' ? 'accepted' : result === 'absent' ? 'pending' : 'unknown');
      expect(calls).toBe(1);
      await harness.advance(1_000);
      expect(calls).toBe(result === 'absent' ? 2 : 1);
      expect(harness.deliveries()[0]!.state).toBe(result === 'unsupported' ? 'unknown' : 'accepted');
    });
  });
}
