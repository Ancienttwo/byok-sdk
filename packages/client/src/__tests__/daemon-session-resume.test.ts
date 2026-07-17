import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok/protocol';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { SessionWorkspaceStore } from '../daemon/session-workspace-store';
import { TestServer } from './fixtures/test-server';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Finding #3 (session/workspace continuity, 2026-07-16 live GLM run): a
 * `task.offer` naming a sessionRef this device previously reported (via a
 * prior task's `task.complete.sessionRef`) must reuse that exact workspace
 * directory — otherwise a runtime adapter's own resume mechanism (e.g. pi's
 * `--session <id>`, scoped to the cwd/project a session was created under)
 * can never actually find the session again. This must survive a daemon
 * restart (the map is persisted under `storeDir`, not held in memory only),
 * and an unknown/absent sessionRef must behave exactly as if this feature
 * didn't exist: a fresh workspace, and no sessionRef forwarded to the
 * adapter at all.
 */
describe('session/workspace continuity across a daemon restart (finding #3)', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  afterEach(async () => {
    await daemon?.stop();
    await server.close();
  });

  it('a follow-up task.offer carrying a previously-reported sessionRef reuses the exact same workspace directory, even after the daemon restarts', async () => {
    server = await TestServer.start();
    const workspaceRoot = await tmpDir('byok-client-workspace-');
    const storeDir = await tmpDir('byok-client-store-'); // shared across both daemon instances below

    const adapter1 = new StubRuntimeAdapter();
    daemon = createDaemonWithAdapters(
      { productName: 'Test', productId: 'test-product', serverUrl: server.url, workspaceRoot, storeDir },
      [adapter1],
    );
    await daemon.pair('code');
    await daemon.start();

    server.send(
      createEnvelope('task.offer', { instruction: 'first task', policy: { mode: 'auto' } }, { taskId: 'task-A', seq: server.nextSeq() }),
    );
    await server.waitFor((e) => e.type === 'task.started');
    await vi.waitFor(() => expect(adapter1.sessions).toHaveLength(1));

    const workspaceDirA = adapter1.startCalls[0]?.ctx.workspaceDir;
    expect(workspaceDirA).toContain('task-A');
    // No sessionRef was offered, so none should have reached the adapter.
    expect(adapter1.startCalls[0]?.task.sessionRef).toBeUndefined();

    adapter1.sessions[0]?.emit({ type: 'progress', text: 'done' });
    adapter1.sessions[0]?.emit({ type: 'turn_end' });
    const complete = await server.waitFor((e) => e.type === 'task.complete' && e.task_id === 'task-A');
    const sessionRefA = (complete.payload as { sessionRef: string }).sessionRef;
    expect(sessionRefA).toBe(adapter1.sessions[0]?.sessionRef);

    await daemon.stop();

    // A fresh daemon instance (simulating a process restart), same
    // storeDir — the sessionRef -> workspace map must be read back from
    // disk, not lost with the old in-memory TaskRunner.
    const adapter2 = new StubRuntimeAdapter();
    const daemon2 = createDaemonWithAdapters(
      { productName: 'Test', productId: 'test-product', serverUrl: server.url, workspaceRoot, storeDir },
      [adapter2],
    );
    daemon = daemon2;
    await daemon2.start(); // no re-pair — device.json already persisted

    server.send(
      createEnvelope(
        'task.offer',
        { instruction: 'follow-up task', policy: { mode: 'auto' }, sessionRef: sessionRefA },
        { taskId: 'task-B', seq: server.nextSeq() },
      ),
    );
    await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-B');
    await vi.waitFor(() => expect(adapter2.sessions).toHaveLength(1));

    expect(adapter2.startCalls[0]?.ctx.workspaceDir).toBe(workspaceDirA);
    // Forwarded intact — this is what lets the adapter actually resume.
    expect(adapter2.startCalls[0]?.task.sessionRef).toBe(sessionRefA);
  });

  it('an unknown/stale sessionRef is stripped before reaching the adapter and gets a fresh workspace, exactly like no sessionRef at all', async () => {
    server = await TestServer.start();
    const workspaceRoot = await tmpDir('byok-client-workspace-');
    const storeDir = await tmpDir('byok-client-store-');

    const adapter = new StubRuntimeAdapter();
    daemon = createDaemonWithAdapters(
      { productName: 'Test', productId: 'test-product', serverUrl: server.url, workspaceRoot, storeDir },
      [adapter],
    );
    await daemon.pair('code');
    await daemon.start();

    server.send(
      createEnvelope(
        'task.offer',
        { instruction: 'x', policy: { mode: 'auto' }, sessionRef: 'never-recorded-anywhere' },
        { taskId: 'task-C', seq: server.nextSeq() },
      ),
    );
    await server.waitFor((e) => e.type === 'task.started');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));

    expect(adapter.startCalls[0]?.ctx.workspaceDir).toContain('task-C');
    expect(adapter.startCalls[0]?.task.sessionRef).toBeUndefined();
  });

  it('records a fresh session\'s own workspace under its own reported sessionRef, so a THIRD dispatch can chain off a resumed session\'s completion too', async () => {
    server = await TestServer.start();
    const workspaceRoot = await tmpDir('byok-client-workspace-');
    const storeDir = await tmpDir('byok-client-store-');
    // The daemon records sessionRef -> workspace fire-and-forget (never
    // blocks task.progress/task.complete on that disk write — see
    // task-runner.ts's `handleOffer`). Real callers can't out-race it: a
    // follow-up dispatch requires a caller to first *observe*
    // `task.complete.sessionRef`, which takes far longer than a local fs
    // write. `StubRuntimeAdapter` has zero such latency, so this test polls
    // the same on-disk store the daemon itself reads/writes instead of
    // assuming the write already landed the instant task.complete arrives.
    const storeView = new SessionWorkspaceStore(storeDir);

    const adapter = new StubRuntimeAdapter();
    daemon = createDaemonWithAdapters(
      { productName: 'Test', productId: 'test-product', serverUrl: server.url, workspaceRoot, storeDir },
      [adapter],
    );
    await daemon.pair('code');
    await daemon.start();

    server.send(
      createEnvelope('task.offer', { instruction: 'first', policy: { mode: 'auto' } }, { taskId: 'task-1', seq: server.nextSeq() }),
    );
    await server.waitFor((e) => e.type === 'task.started');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    const workspaceDir1 = adapter.startCalls[0]?.ctx.workspaceDir;
    adapter.sessions[0]?.emit({ type: 'turn_end' });
    const complete1 = await server.waitFor((e) => e.type === 'task.complete' && e.task_id === 'task-1');
    const sessionRef1 = (complete1.payload as { sessionRef: string }).sessionRef;
    await vi.waitFor(async () => expect(await storeView.get(sessionRef1)).toBeDefined());

    server.send(
      createEnvelope(
        'task.offer',
        { instruction: 'second (resume)', policy: { mode: 'auto' }, sessionRef: sessionRef1 },
        { taskId: 'task-2', seq: server.nextSeq() },
      ),
    );
    await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-2');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(2));
    expect(adapter.startCalls[1]?.ctx.workspaceDir).toBe(workspaceDir1);
    expect(adapter.startCalls[1]?.task.sessionRef).toBe(sessionRef1);

    // The stub adapter's start() reuses task.sessionRef verbatim as the new
    // session's own sessionRef when one was forwarded — so a chained third
    // dispatch resuming *this* task's reported sessionRef must still land in
    // the same workspace.
    adapter.sessions[1]?.emit({ type: 'turn_end' });
    const complete2 = await server.waitFor((e) => e.type === 'task.complete' && e.task_id === 'task-2');
    const sessionRef2 = (complete2.payload as { sessionRef: string }).sessionRef;
    expect(sessionRef2).toBe(sessionRef1);
    await vi.waitFor(async () => expect(await storeView.get(sessionRef2)).toBeDefined());

    server.send(
      createEnvelope(
        'task.offer',
        { instruction: 'third (resume again)', policy: { mode: 'auto' }, sessionRef: sessionRef2 },
        { taskId: 'task-3', seq: server.nextSeq() },
      ),
    );
    await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-3');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(3));
    expect(adapter.startCalls[2]?.ctx.workspaceDir).toBe(workspaceDir1);
  });
});
