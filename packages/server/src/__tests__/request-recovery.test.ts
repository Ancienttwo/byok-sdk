import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { createByokServer, createHmacTokenSigner } from '../index';
import { connectFakeDaemonLongPoll, startServer, stopServer, claimAndStart, sendOne } from './test-support';

describe('public facade request recovery', () => {
  it('reads the original offer/result and cancels by pre-persisted identity after reopen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'byok-request-recovery-'));
    const options = { productId: 'request-recovery', storage: { kind: 'sqlite' as const, path: join(root, 'server.sqlite') },
      tokenSigner: createHmacTokenSigner(new Uint8Array(32).fill(7), { now: () => new Date() }), longPollHoldMs: 10 };
    let byok = createByokServer(options); let http = await startServer(byok);
    try {
      const daemon = await connectFakeDaemonLongPoll(http.baseUrl, byok, { productId: options.productId });
      const input = { taskId: 'host-persisted-a', deviceId: daemon.deviceId, instruction: 'original', runtime: 'claude' as const, policy: { mode: 'auto' as const } };
      await expect(byok.dispatch({ ...input, deviceId: undefined })).rejects.toThrow('explicit deviceId');
      await expect(byok.dispatch({ ...input, taskId: '' })).rejects.toThrow('non-empty');
      const mutable = { ...input, taskId: 'captured-before-await' };
      const captured = byok.dispatch(mutable);
      mutable.taskId = 'mutated-after-call';
      expect((await captured).taskId).toBe('captured-before-await');
      const handle = await byok.dispatch(input);
      expect(handle.taskId).toBe(input.taskId);
      const original = await byok.tasks.offer(input.taskId);
      expect(original).toMatchObject({ taskId: input.taskId, deviceId: daemon.deviceId, delivered: true,
        type: 'task.offer', payload: { instruction: 'original', runtime: 'claude', policy: { mode: 'auto' } } });
      for (const retry of [input, { ...input, instruction: 'changed' }]) {
        await expect(byok.dispatch(retry)).rejects.toMatchObject({ code: 'coordination_input_invalid' });
      }
      await claimAndStart(byok, daemon, handle);
      expect(await sendOne(daemon, createEnvelope('task.complete', { summary: 'first', sessionRef: 'session-first' }, { taskId: handle.taskId }))).toMatchObject({ status: 200, body: { accepted: 1 } });
      const result = (await byok.tasks.get(handle.taskId))?.result;
      const cancellable = await byok.dispatch({ ...input, taskId: 'host-persisted-b' });
      const concurrent = await Promise.allSettled([byok.dispatch({ ...input, taskId: 'concurrent' }), byok.dispatch({ ...input, taskId: 'concurrent' })]);
      expect(concurrent.filter(item => item.status === 'fulfilled')).toHaveLength(1);
      await stopServer(http.server); await byok.close();
      byok = createByokServer(options); http = await startServer(byok);
      expect(await byok.tasks.offer(input.taskId)).toEqual(original);
      expect((await byok.tasks.get(input.taskId))?.result).toEqual(result);
      await byok.tasks.cancel(cancellable.taskId, 'host cancellation after restart');
      expect((await byok.tasks.get(cancellable.taskId))?.result).toMatchObject({ state: 'Cancelled', reason: 'host cancellation after restart' });
      await expect(byok.tasks.cancel('unknown')).rejects.toMatchObject({ code: 'task_not_found' });
      const foreign = createByokServer({ ...options, productId: 'other-product' });
      try {
        expect(await foreign.tasks.offer(input.taskId)).toBeUndefined();
        expect(await foreign.tasks.get(input.taskId)).toBeUndefined();
        await expect(foreign.tasks.cancel(cancellable.taskId)).rejects.toMatchObject({ code: 'task_not_found' });
      } finally { await foreign.close(); }
    } finally { await stopServer(http.server); await byok.close(); rmSync(root, { recursive: true, force: true }); }
  });
});
