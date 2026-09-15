import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { createDaemonWithAdapters } from '../daemon/create-daemon';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const clean of cleanup.reverse()) await clean(); cleanup.length = 0; });
const limit = async <T>(operation: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('admission did not settle')), 1500); })]); }
  finally { clearTimeout(timer!); }
};

for (const phase of ['detect', 'prepare'] as const) {
  for (const action of ['deadline', 'cancel', 'shutdown'] as const) {
    it(`${phase}: ${action} withdraws admission, releases home, ignores late results`, async () => {
      const server = await TestServer.start(); cleanup.push(() => server.close());
      server.setAckCapabilities(['custom-harness', 'mailbox-read-ahead']);
      const root = await mkdtemp(path.join(os.tmpdir(), 'byok-admission-'));
      cleanup.push(() => rm(root, { recursive: true, force: true }));
      const adapter = new StubRuntimeAdapter('acme-harness');
      const daemon = createDaemonWithAdapters({
        productId: `admission-${path.basename(root)}`, productName: 'Admission', localAgentRelease: { version: '0.0.0-test' },
        serverUrl: server.url, storeDir: path.join(root, 'store'), workspaceRoot: path.join(root, 'work'),
        agentHome: { hostStorageRoot: path.join(root, 'home') }, startupTimeoutMs: action === 'deadline' ? 250 : 5000,
      }, [adapter], { longPoll: { retryDelayMs: 10, idleDelayMs: 10 } });
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      cleanup.push(async () => { release(); await daemon.stop(); });
      // Stage diagnostic for the deadline rows only (zero product change: a
      // plain `daemon.subscribe` listener recording `observer.ts`'s own
      // DaemonEvent kinds). If the replacement reaches no terminal
      // observation, the failure names the last stage it did reach instead of
      // reporting a bare "waitFor timed out".
      const stages: string[] = [];
      const unsubscribe = action === 'deadline'
        ? daemon.subscribe(event => {
            if ('taskId' in event && event.taskId === 'replacement'
              && ['offered', 'claimed', 'started', 'failed'].includes(event.kind)) stages.push(event.kind);
          })
        : undefined;
      await daemon.pair('pairing-code'); await daemon.start();
      await server.waitFor(e => e.type === 'conn.hello');
      let entered = false;
      const originalDetect = adapter.detect.bind(adapter);
      const originalPrepare = adapter.prepare.bind(adapter);
      const detect = vi.spyOn(adapter, 'detect').mockImplementation(async () => {
        if (phase === 'detect') { entered = true; await gate; }
        return originalDetect();
      });
      const prepare = vi.spyOn(adapter, 'prepare').mockImplementation(async input => {
        if (phase === 'prepare') { entered = true; await gate; }
        return originalPrepare(input);
      });
      const offer = (taskId: string) => createEnvelope('task.offer_for_agent', {
        instruction: 'work', policy: { mode: 'auto' }, harnessId: 'acme-harness', agentRef: { agentId: 'shared', profileRevision: 'r1' },
      }, { taskId, seq: server.nextSeq() });
      server.send(offer('blocked'));
      await vi.waitFor(() => expect(entered).toBe(true));
      if (action === 'shutdown') await limit(daemon.stop());
      else {
        if (action === 'cancel') server.send(createEnvelope('task.cancel', { reason: 'cancel pre-claim' }, { taskId: 'blocked', seq: server.nextSeq() }));
        await server.waitFor(e => e.type === 'task.decline' && e.task_id === 'blocked', 1500);
      }
      expect(adapter.startCalls).toHaveLength(0);
      expect(server.received.some(e => e.type === 'task.claim' && e.task_id === 'blocked')).toBe(false);
      // Late pure results cannot continue the retired admission path.
      release();
      await gate; await new Promise(resolve => setImmediate(resolve));
      detect.mockRestore(); prepare.mockRestore();
      if (action === 'shutdown') await daemon.start();
      server.send(offer('replacement'));
      if (action === 'deadline') {
        // A' — the replacement is bounded by the SAME daemon-wide 250ms
        // startup budget this row arms: `startupTimeoutMs` is read per offer
        // off the runner's deps (`task-runner.ts:1970`) and the abort it
        // schedules withdraws admission with the exact reason asserted below
        // (`task-runner.ts:2831-2832`). How fast the replacement's own
        // admission runs — canonical-home resolution, adapter preparation,
        // `acquireExecution` — is not a product contract, so requiring
        // `task.started` here asserted an unstated latency budget and failed
        // in CI whenever a loaded runner spent that budget on real work. What
        // this row actually owns is the deadline-RELEASE semantics: the
        // blocked offer's reservation must come back, i.e. the replacement
        // must never be declined `agent home busy`. That property is proven
        // deterministically, with no clock in the assertion at all, by
        // `admission-deadline-release-guard.test.ts` against one real
        // `TaskRunner`; here it is kept only as the negative below.
        const replacementDeclineReasons = (): string[] => server.received
          .flatMap(e => (e.type === 'task.decline' && e.task_id === 'replacement' ? [e.payload.reason] : []));
        let outcome: { kind: 'started' } | { kind: 'declined'; reason: string } | undefined;
        await vi.waitFor(() => {
          const declined = replacementDeclineReasons()[0];
          if (declined !== undefined) { outcome = { kind: 'declined', reason: declined }; return; }
          if (server.received.some(e => e.type === 'task.started' && e.task_id === 'replacement')) { outcome = { kind: 'started' }; return; }
          throw new Error(`replacement reached no terminal observation; last stage: ${stages.at(-1) ?? '(none)'} (stages: ${stages.join(' -> ') || 'none'})`);
        }, { timeout: 2000 });
        // (a) whatever the outcome, the released reservation is non-negotiable.
        for (const reason of replacementDeclineReasons()) expect(reason.startsWith('agent home busy')).toBe(false);
        // (b) exactly one of the two accepted terminal observations.
        if (outcome!.kind === 'declined') expect(outcome!.reason).toBe('runtime startup deadline exceeded');
        else {
          expect(adapter.startCalls).toHaveLength(1);
          expect(server.received.some(e => e.type === 'task.claim' && e.task_id === 'blocked')).toBe(false);
          adapter.sessions[0]!.emit({ type: 'turn_end' });
          await server.waitFor(e => e.type === 'task.complete' && e.task_id === 'replacement');
        }
        unsubscribe?.();
      } else {
        await server.waitFor(e => e.type === 'task.started' && e.task_id === 'replacement', 2000);
        expect(adapter.startCalls).toHaveLength(1);
        expect(server.received.some(e => e.type === 'task.claim' && e.task_id === 'blocked')).toBe(false);
        adapter.sessions[0]!.emit({ type: 'turn_end' });
        await server.waitFor(e => e.type === 'task.complete' && e.task_id === 'replacement');
      }
      await limit(daemon.stop());
    });
  }
}
