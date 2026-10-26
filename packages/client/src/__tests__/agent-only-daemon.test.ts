import { testScratchRoot } from "./fixtures/execution-scratch";
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { TestServer } from './fixtures/test-server';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

async function temp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('Agent-only daemon admission (#925)', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  beforeEach(async () => { server = await TestServer.start(); });
  afterEach(async () => {
    await daemon?.stop();
    await server.close();
  });

  async function startDaemon(options: { workspaceRoot?: boolean; agentHome?: boolean } = {}): Promise<StubRuntimeAdapter> {
    const workspaceRoot = options.workspaceRoot === false ? undefined : await temp('byok-agent-only-workspace-');
    const storeDir = await temp('byok-agent-only-store-');
    const hostStorageRoot = await temp('byok-agent-only-home-');
    const adapter = new StubRuntimeAdapter('pi');
    daemon = createDaemonWithAdapters({ storage: { scratchRoot: testScratchRoot() },
      localAgentRelease: { version: '0.0.0-test' },
      productName: 'Agent-only test',
      productId: `agent-only-${path.basename(storeDir)}`,
      serverUrl: server.url,
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
      storeDir,
      ...(options.agentHome === false ? {} : { agentHome: { hostStorageRoot } }),
    }, [adapter]);
    await daemon.pair('pairing-code');
    await daemon.start();
    return adapter;
  }

  it('advertises the Agent home contract and no strict-only flag', async () => {
    await startDaemon();
    const hello = await server.waitFor((entry) => entry.type === 'conn.hello');
    if (hello.type !== 'conn.hello') throw new Error('unreachable');
    expect(hello.payload.capabilities).toContain('agent-home-contract');
    expect(hello.payload.capabilities).not.toContain('strict-agent-only');
  });

  it('declines an Agent offer before claim when the daemon has no Agent home', async () => {
    const adapter = await startDaemon({ agentHome: false });
    const agentRef = { agentId: 'homeless-agent', profileRevision: 'r1' };
    server.send(createEnvelope('task.offer_for_agent', { instruction: 'agent work', agentRef }, { taskId: 'no-home-offer', seq: server.nextSeq() }));
    const decline = await server.waitFor((entry) => entry.type === 'task.decline' && entry.task_id === 'no-home-offer');
    expect(decline.payload).toMatchObject({ retryable: false, agentRef });
    expect(adapter.sessions).toHaveLength(0);
    expect(server.received.some((entry) => entry.type === 'task.claim')).toBe(false);
  });

  it('keeps construction filesystem-free until daemon ownership and async preflight', async () => {
    const root = await temp('byok-agent-only-construction-');
    const hostStorageRoot = path.join(root, 'not-created-yet');
    daemon = createDaemonWithAdapters({ storage: { scratchRoot: testScratchRoot() },
      localAgentRelease: { version: '0.0.0-test' },
      productName: 'Agent-only test',
      productId: `agent-only-construction-${path.basename(root)}`,
      serverUrl: server.url,
      workspaceRoot: path.join(root, 'workspace'),
      storeDir: path.join(root, 'store'),
      agentHome: { hostStorageRoot },
    }, [new StubRuntimeAdapter('pi')]);

    await expect(fs.lstat(hostStorageRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(path.join(root, 'store'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains cancel and dedup precedence before admission', async () => {
    const adapter = await startDaemon();
    const cancelled = 'agent-pre-cancel';
    server.send(createEnvelope('task.cancel', { reason: 'operator cancelled first' }, { taskId: cancelled, seq: server.nextSeq() }));
    server.send(createEnvelope('task.offer_for_agent', {
      instruction: 'agent work', agentRef: { agentId: 'pre-cancel-agent', profileRevision: 'r1' },
    }, { taskId: cancelled, seq: server.nextSeq() }));
    const cancellationDecline = await server.waitFor((entry) => entry.type === 'task.decline' && entry.task_id === cancelled);
    expect((cancellationDecline.payload as { reason: string }).reason).toMatch(/cancelled before claim/i);

    const duplicate = createEnvelope('task.offer_for_agent', {
      instruction: 'agent work', agentRef: { agentId: 'duplicate-agent', profileRevision: 'r1' },
    }, { taskId: 'agent-duplicate', seq: server.nextSeq() });
    server.send(duplicate);
    await server.waitFor((entry) => entry.type === 'task.claim' && entry.task_id === 'agent-duplicate');
    server.send({ ...duplicate, seq: server.nextSeq() });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(server.received.filter((entry) => entry.type === 'task.claim' && entry.task_id === 'agent-duplicate')).toHaveLength(1);
    expect(adapter.sessions).toHaveLength(1);
  });

  it('runs an Agent offer without a workspaceRoot (#319)', async () => {
    const adapter = await startDaemon({ workspaceRoot: false });
    server.send(createEnvelope('task.offer_for_agent', {
      instruction: 'agent work', agentRef: { agentId: 'no-root-agent', profileRevision: 'r1' },
    }, { taskId: 'no-root-agent-offer', seq: server.nextSeq() }));
    await server.waitFor((entry) => entry.type === 'task.claim' && entry.task_id === 'no-root-agent-offer');
    expect(adapter.sessions).toHaveLength(1);
    adapter.sessions[0]!.emit({ type: 'progress', text: 'done' });
    adapter.sessions[0]!.emit({ type: 'turn_end' });
    await server.waitFor((entry) => entry.type === 'task.complete' && entry.task_id === 'no-root-agent-offer');
  });
});
