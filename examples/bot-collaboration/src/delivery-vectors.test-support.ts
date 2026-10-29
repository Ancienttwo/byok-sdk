import { describe, expect, it } from 'vitest';
import type { Json } from '@byok-sdk/server/execution-core';
import { inboundKey, type ChannelPort, type Delivery } from './channel';
import type { CollaborationState } from './model';

/**
 * #793 D2b-out delivery vectors. Each Host runs the same cases: the K8 L ledger now, and the H outbox sender in D2b-out-2.
 * Each vector scripts its own `ChannelPort` and keeps its own call log. A subject sees only Host verbs and the K8 delivery
 * entities, not its row layout, and every read may be async.
 *
 * The subject's Bot `main` takes owner messages on channel `fake` in its direct conversation, and the configured self bot of
 * that channel is `own-bot`. Its business send deadline outlasts the steps of a case, so a held send is still in flight while
 * later verbs run, and a send that never settles times out within the case.
 * `drain`, `advance`, `publish`, `end`, `echo`, `resend`, `enablePush` and `revokePush` each end by running the Host, with
 * one sender pass: a due row is sent inside the verb.
 */
export interface DeliverySubject {
  /** The Host clock. */
  now(): number;
  /** Runs the Host. */
  drain(): Promise<void>;
  /** Moves the clock by `ms`, then runs the Host. */
  advance(ms: number): Promise<void>;
  /**
   * The owner message `key` (`platformMessageId = key`) reaches Bot `main`. Its reply route is valid for `replyMs` and holds
   * the token `replyToken(key)`; `replyMs: null` sends no route. Its Turn runs, and its final Agent message `FINAL_BODY` is
   * accepted, which queues the delivery. Then the Host runs.
   */
  publish(key: string, options?: { replyMs?: number | null }): Promise<void>;
  /** The owner cancels the Turn of owner message `key` (`cancel_turn`). The Host runs until the Turn has its conclusion. */
  end(key: string): Promise<void>;
  /**
   * Holds the next send call: its claim commits and the send starts, but the call does not return until `release`. The verb
   * that makes the claim returns once the send has started. While the send is held, the Host that holds it is busy, and each
   * verb runs another Host from the stored state, which takes the claim over after `recoveryMs`. `release` lets the send
   * return its scripted result, and waits until the holding Host has handled it. A second hold may start while the first is
   * held; each one holds its own Host.
   */
  holdNextSend(): { release(): Promise<void> };
  /**
   * Holds the next readback call in the same way: the port is called at once, so its result is the one at that time, and
   * the result returns to the Host at `release`.
   */
  holdNextReadback(): { release(): Promise<void> };
  /** The owner opts the direct conversation of Bot `main` into push on channel `fake`. Returns the route id. */
  enablePush(target: string): Promise<string>;
  revokePush(routeId: string): Promise<void>;
  /** A verified echo of `own-bot` on channel `fake` for delivery `deliveryId`, with this platform message id. */
  echo(deliveryId: string, platformMessageId: string): Promise<void>;
  /** The owner's manual resend of an `unknown` delivery. Returns the new delivery id. */
  resend(deliveryId: string): Promise<string>;
  /**
   * The next send claim commits, and the Host that made it never settles it: a Host that starts again from the stored
   * state takes over. The subject applies it inside the verb that makes the claim.
   */
  crashOnNextSend(): void;
  /** How long after `crashOnNextSend` or a held send another Host recovers the claim. L recovers at startup; H after its lease. */
  readonly recoveryMs: number;
  /** The K8 delivery entities, in insertion order. */
  deliveries(): Delivery[] | Promise<Delivery[]>;
  /** Every projection that the Host published, sent or not. */
  projections(): Array<{ id: string; value: Json }> | Promise<Array<{ id: string; value: Json }>>;
  state(): CollaborationState | Promise<CollaborationState>;
  /** Every stored row of the Host, as text. */
  stored(): string | Promise<string>;
}

export const FINAL_BODY = 'Final answer';
/** The reply route token of owner message `key`. */
export const replyToken = (key: string) => `secret-${key}`;
const DIRECT = { kind: 'direct', id: 'main' } as const;
type SendInput = Parameters<ChannelPort['send']>[0];
type SendResult = Awaited<ReturnType<ChannelPort['send']>>;
const accepted = (platformMessageId: string): SendResult => ({ result: 'accepted', platformMessageId });
/** A scripted send: one result or throw per call, the last one repeating. Each call is logged. */
function scripted(...results: Array<SendResult | Error | 'hang'>) {
  const calls: SendInput[] = [];
  const send: ChannelPort['send'] = async input => {
    calls.push(structuredClone(input));
    const result = results[Math.min(calls.length, results.length) - 1]!;
    if (result === 'hang') return new Promise<never>(() => {});
    if (result instanceof Error) throw result;
    return result;
  };
  return { calls, send };
}

export function deliveryVectors(name: string, open: (port: ChannelPort) => Promise<DeliverySubject>): void {
  describe(`delivery contract: ${name}`, () => {
    it('1. sends a reply-route delivery once, with the token only in the route, and settles it accepted', async () => {
      const port = scripted(accepted('p1')), subject = await open(port);
      await subject.publish('in1');
      await subject.drain();
      const [row] = await subject.deliveries();
      expect(row).toMatchObject({ body: FINAL_BODY, channel: 'fake', conversation: DIRECT, route: { kind: 'reply', inboundId: inboundKey({ channel: 'fake',
        conversation: DIRECT, platformMessageId: 'in1' } as never) }, state: 'accepted', attempts: 1, platformMessageId: 'p1' });
      expect(port.calls).toEqual([{ deliveryId: row!.id, body: FINAL_BODY, route: { kind: 'reply', channel: 'fake', inboundId: 'in1',
        token: replyToken('in1'), expiresAt: expect.any(Number) } }]);
    }, 60_000);

    it('2. backs a retryable rejection off by its wait, and the third attempt stops', async () => {
      const port = scripted({ result: 'rejected', code: '429', retryable: true, retryAfterMs: 5_000 }), subject = await open(port);
      await subject.publish('in1');
      expect(await subject.deliveries()).toMatchObject([{ state: 'pending', attempts: 1, code: '429', nextAttemptAt: subject.now() + 5_000 }]);
      await subject.advance(4_999);
      expect(port.calls).toHaveLength(1);
      await subject.advance(1);
      expect(port.calls).toHaveLength(2);
      await subject.advance(5_000);
      expect(port.calls).toHaveLength(3);
      expect(await subject.deliveries()).toMatchObject([{ state: 'rejected', attempts: 3, code: '429' }]);
      await subject.advance(60_000);
      expect(port.calls).toHaveLength(3);
    }, 60_000);

    it('3. stops at a rejection that is not retryable', async () => {
      const port = scripted({ result: 'rejected', code: 'permission_denied', retryable: false }), subject = await open(port);
      await subject.publish('in1');
      expect(await subject.deliveries()).toMatchObject([{ state: 'rejected', attempts: 1, code: 'permission_denied' }]);
      await subject.advance(120_000);
      expect(port.calls).toHaveLength(1);
    }, 60_000);

    it('4. rejects a retryable rejection whose wait is over 60 s', async () => {
      const port = scripted({ result: 'rejected', code: '429', retryable: true, retryAfterMs: 60_001 }), subject = await open(port);
      await subject.publish('in1');
      expect(await subject.deliveries()).toMatchObject([{ state: 'rejected', attempts: 1, code: '429' }]);
      await subject.advance(120_000);
      expect(port.calls).toHaveLength(1);
    }, 60_000);

    it.each([['send_timeout', 'hang'], ['send_failed', new Error('connection lost after write')]] as const)(
      '5. leaves a send that ends in %s unknown, and never sends it again by itself', async (code, outcome) => {
        const port = scripted(outcome), subject = await open(port);
        await subject.publish('in1');
        expect(await subject.deliveries()).toMatchObject([{ state: 'unknown', attempts: 1, code }]);
        await subject.advance(120_000);
        expect(port.calls).toHaveLength(1);
      }, 60_000);

    it.each(['accepted', 'absent'] as const)('6. settles an unknown delivery from a readback of %s', async result => {
      const port = scripted(new Error('receipt lost'), accepted('p2')), read: string[] = [];
      const subject = await open({ send: port.send, readback: async id => { read.push(id); return result; } });
      await subject.publish('in1');
      await subject.drain();
      const [row] = await subject.deliveries();
      expect(read).toContain(row!.id);
      expect(row).toMatchObject(result === 'accepted' ? { state: 'accepted', attempts: 1 } : { state: 'pending', attempts: 1, nextAttemptAt: subject.now() + 1_000 });
      await subject.advance(1_000);
      expect(port.calls).toHaveLength(result === 'absent' ? 2 : 1);
      expect(await subject.deliveries()).toMatchObject([{ state: 'accepted', attempts: result === 'absent' ? 2 : 1 }]);
    }, 60_000);

    it('7. turns a send claim that its Host never settled into unknown (interrupted), and sends it no more', async () => {
      const port = scripted(accepted('late')), subject = await open(port);
      subject.crashOnNextSend();
      await subject.publish('in1');
      await subject.advance(subject.recoveryMs);
      expect(await subject.deliveries()).toMatchObject([{ state: 'unknown', attempts: 1, code: 'interrupted' }]);
      await subject.advance(120_000);
      expect(port.calls).toHaveLength(1);
    }, 60_000);

    it('8. refuses a pending reply after its route expired, and sends the push fallback', async () => {
      const port = scripted({ result: 'rejected', code: '503', retryable: true, retryAfterMs: 20_000 }, accepted('pushed'));
      const subject = await open(port), push = await subject.enablePush('direct-target');
      await subject.publish('in1', { replyMs: 10_000 });
      expect(port.calls.map(call => call.route.kind)).toEqual(['reply']);
      await subject.advance(20_000);
      await subject.drain();
      const rows = await subject.deliveries();
      expect(rows).toMatchObject([
        { route: { kind: 'reply' }, state: 'rejected', attempts: 1, code: 'reply_route_expired' },
        { route: { kind: 'push', pushRouteId: push }, body: FINAL_BODY, state: 'accepted', attempts: 1, platformMessageId: 'pushed' },
      ]);
      expect(port.calls.map(call => call.route.kind)).toEqual(['reply', 'push']);
      expect(port.calls[1]).toMatchObject({ deliveryId: rows[1]!.id, route: { kind: 'push', id: push, target: 'direct-target' } });
    }, 60_000);

    it('9. rejects the pending deliveries of a revoked push route', async () => {
      const port = scripted({ result: 'rejected', code: '503', retryable: true, retryAfterMs: 20_000 });
      const subject = await open(port), push = await subject.enablePush('direct-target');
      await subject.publish('in1', { replyMs: null });
      expect(await subject.deliveries()).toMatchObject([{ route: { kind: 'push', pushRouteId: push }, state: 'pending', attempts: 1 }]);
      await subject.revokePush(push);
      expect(await subject.deliveries()).toMatchObject([{ state: 'rejected', attempts: 1, code: 'push_route_revoked' }]);
      await subject.advance(60_000);
      expect(port.calls).toHaveLength(1);
    }, 60_000);

    it('10. accepts an unknown delivery from a verified echo', async () => {
      const port = scripted(new Error('receipt lost')), subject = await open(port);
      await subject.publish('in1');
      const [row] = await subject.deliveries();
      expect(row).toMatchObject({ state: 'unknown', attempts: 1 });
      await subject.echo(row!.id, 'echoed');
      expect(await subject.deliveries()).toMatchObject([{ id: row!.id, state: 'accepted', attempts: 1, platformMessageId: 'echoed' }]);
      await subject.advance(120_000);
      expect(port.calls).toHaveLength(1);
    }, 60_000);

    it('11. gives a manual resend of an unknown delivery a new id, and sends it', async () => {
      const port = scripted(new Error('receipt lost'), accepted('again')), subject = await open(port);
      await subject.publish('in1');
      const [old] = await subject.deliveries();
      const next = await subject.resend(old!.id);
      expect(next).not.toBe(old!.id);
      await subject.drain();
      expect(await subject.deliveries()).toMatchObject([
        { id: old!.id, state: 'unknown', attempts: 1 },
        { id: next, resendOf: old!.id, state: 'accepted', attempts: 1, platformMessageId: 'again' },
      ]);
      expect(port.calls.map(call => call.deliveryId)).toEqual([old!.id, next]);
    }, 60_000);

    it('12. drops the stored reply token once its route expires', async () => {
      const port = scripted(accepted('p1')), subject = await open(port);
      await subject.publish('in1', { replyMs: 10_000 });
      expect(await subject.stored()).toContain(replyToken('in1'));
      await subject.advance(10_000);
      const inbound = Object.values((await subject.state()).channel!.inbounds)[0]!;
      expect(inbound.reply).toBeDefined();
      expect(inbound.reply!.token).toBeUndefined();
      expect(await subject.stored()).not.toContain(replyToken('in1'));
    }, 60_000);

    it('13. keeps the reply token out of every projection and every channel call field except the send route', async () => {
      const port = scripted(new Error('receipt lost'), accepted('again')), read: string[] = [];
      const subject = await open({ send: port.send, readback: async id => { read.push(id); return 'absent'; } });
      await subject.publish('in1');
      await subject.advance(1_000);
      expect(port.calls).toHaveLength(2);
      // The Turn ends, so the Host publishes its projection.
      await subject.end('in1');
      for (const call of port.calls) {
        expect(call.route).toMatchObject({ kind: 'reply', token: replyToken('in1') });
        expect(JSON.stringify({ ...call, route: undefined })).not.toContain(replyToken('in1'));
      }
      expect(JSON.stringify(read)).not.toContain(replyToken('in1'));
      const projections = await subject.projections();
      expect(projections.length).toBeGreaterThan(0);
      expect(JSON.stringify(projections)).not.toContain(replyToken('in1'));
    }, 60_000);

    it('14. accepts a delivery from a verified echo that arrives while its send is held, and keeps the echo', async () => {
      const port = scripted(accepted('sent')), subject = await open(port);
      const held = subject.holdNextSend();
      await subject.publish('in1');
      const [row] = await subject.deliveries();
      expect(row).toMatchObject({ state: 'sending', attempts: 1 });
      await subject.echo(row!.id, 'echoed');
      expect(await subject.deliveries()).toMatchObject([{ id: row!.id, state: 'accepted', attempts: 1, platformMessageId: 'echoed' }]);
      // The send then completes. Its result cannot replace the echo.
      await held.release();
      expect(await subject.deliveries()).toMatchObject([{ id: row!.id, state: 'accepted', attempts: 1, platformMessageId: 'echoed' }]);
      expect(port.calls).toHaveLength(1);
    }, 60_000);

    it('15. ignores a held send that completes after another Host recovered its claim', async () => {
      const port = scripted(accepted('late')), subject = await open(port);
      const held = subject.holdNextSend();
      await subject.publish('in1');
      expect(await subject.deliveries()).toMatchObject([{ state: 'sending', attempts: 1 }]);
      await subject.advance(subject.recoveryMs);
      expect(await subject.deliveries()).toMatchObject([{ state: 'unknown', attempts: 1, code: 'interrupted' }]);
      await held.release();
      const [row] = await subject.deliveries();
      expect(row).toMatchObject({ state: 'unknown', attempts: 1, code: 'interrupted' });
      expect(row!.platformMessageId).toBeUndefined();
      await subject.advance(120_000);
      expect(port.calls).toHaveLength(1);
    }, 60_000);

    it('16. drops the stored reply token once its root closes', async () => {
      const port = scripted(accepted('p1')), subject = await open(port);
      await subject.publish('in1');
      expect(await subject.deliveries()).toMatchObject([{ state: 'accepted' }]);
      expect(await subject.stored()).toContain(replyToken('in1'));
      await subject.end('in1');
      const inbound = Object.values((await subject.state()).channel!.inbounds)[0]!;
      expect(inbound.reply).toMatchObject({ inboundId: 'in1' });
      expect(inbound.reply!.token).toBeUndefined();
      expect(await subject.stored()).not.toContain(replyToken('in1'));
    }, 60_000);

    it('17. rejects an uncertain delivery whose readback is absent after its third attempt (attempts_exhausted)', async () => {
      const port = scripted(new Error('receipt lost'));
      const subject = await open({ send: port.send, readback: async () => 'absent' });
      await subject.publish('in1');
      await subject.drain();
      expect(await subject.deliveries()).toMatchObject([{ state: 'pending', attempts: 1, nextAttemptAt: subject.now() + 1_000 }]);
      await subject.advance(1_000);
      await subject.drain();
      expect(await subject.deliveries()).toMatchObject([{ state: 'pending', attempts: 2, nextAttemptAt: subject.now() + 2_000 }]);
      await subject.advance(2_000);
      await subject.drain();
      expect(await subject.deliveries()).toMatchObject([{ state: 'rejected', attempts: 3, code: 'attempts_exhausted' }]);
      await subject.advance(60_000);
      expect(port.calls).toHaveLength(3);
    }, 60_000);

    it('18. ignores a readback result for an earlier attempt that arrives after a later attempt went unknown', async () => {
      const port = scripted(new Error('receipt lost'));
      let found: 'absent' | 'unsupported' = 'unsupported';
      const subject = await open({ send: port.send, readback: async () => found });
      await subject.publish('in1');
      expect(await subject.deliveries()).toMatchObject([{ state: 'unknown', attempts: 1 }]);
      // One Host reads attempt 1 back as absent, and its result is held.
      found = 'absent';
      const held = subject.holdNextReadback();
      await subject.advance(60_000);
      // Another Host reads it back as absent too, and the delivery waits for attempt 2.
      await subject.advance(60_000);
      expect(await subject.deliveries()).toMatchObject([{ state: 'pending', attempts: 1 }]);
      found = 'unsupported';
      await subject.advance(1_000);
      expect(await subject.deliveries()).toMatchObject([{ state: 'unknown', attempts: 2 }]);
      // The held absent of attempt 1 is no evidence for attempt 2.
      await held.release();
      const [row] = await subject.deliveries();
      expect(row).toMatchObject({ state: 'unknown', attempts: 2 });
      expect(row!.nextAttemptAt).toBeUndefined();
      await subject.advance(60_000);
      expect(port.calls).toHaveLength(2);
    }, 60_000);

    it('19. ignores a held send of attempt 1 that completes while attempt 2 is sending', async () => {
      const port = scripted(accepted('late'), accepted('p2'));
      const subject = await open({ send: port.send, readback: async () => 'absent' });
      const first = subject.holdNextSend();
      await subject.publish('in1');
      // Another Host recovers attempt 1, reads it back as absent, and sends attempt 2, which is held too.
      await subject.advance(subject.recoveryMs);
      expect(await subject.deliveries()).toMatchObject([{ state: 'pending', attempts: 1 }]);
      const second = subject.holdNextSend();
      await subject.advance(1_000);
      expect(await subject.deliveries()).toMatchObject([{ state: 'sending', attempts: 2 }]);
      await first.release();
      const [row] = await subject.deliveries();
      expect(row).toMatchObject({ state: 'sending', attempts: 2 });
      expect(row!.platformMessageId).toBeUndefined();
      await second.release();
      expect(await subject.deliveries()).toMatchObject([{ state: 'accepted', attempts: 2, platformMessageId: 'p2' }]);
      expect(port.calls).toHaveLength(2);
    }, 60_000);
  });
}
