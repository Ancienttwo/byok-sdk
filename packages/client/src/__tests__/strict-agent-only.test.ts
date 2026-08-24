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

describe('strict Agent-only daemon admission', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  beforeEach(async () => { server = await TestServer.start(); });
  afterEach(async () => {
    await daemon?.stop();
    await server.close();
  });

  async function startStrict(): Promise<StubRuntimeAdapter> {
    const workspaceRoot = await temp('byok-strict-workspace-');
    const storeDir = await temp('byok-strict-store-');
    const hostStorageRoot = await temp('byok-strict-home-');
    const adapter = new StubRuntimeAdapter('pi');
    daemon = createDaemonWithAdapters({
      localAgentRelease: { version: '0.0.0-test' },
      productName: 'Strict test',
      productId: `strict-${path.basename(storeDir)}`,
      serverUrl: server.url,
      workspaceRoot,
      storeDir,
      agentHome: { hostStorageRoot },
      strictAgentOnly: true,
    }, [adapter]);
    await daemon.pair('pairing-code');
    await daemon.start();
    const hello = await server.waitFor((entry) => entry.type === 'conn.hello');
    if (hello.type !== 'conn.hello') throw new Error('unreachable');
    expect(hello.payload.capabilities).toContain('agent-home-contract');
    expect(hello.payload.capabilities).toContain('strict-agent-only');
    return adapter;
  }

  it('fails construction closed when strict Agent-only has no preflightable Agent home', async () => {
    expect(() => createDaemonWithAdapters({
      localAgentRelease: { version: '0.0.0-test' }, productName: 'Strict test', productId: 'strict-no-home',
      serverUrl: server.url, workspaceRoot: awaitablePath(), strictAgentOnly: true,
    }, [new StubRuntimeAdapter('pi')])).toThrow(/strictAgentOnly requires.*agentHome/i);
  });

  it('keeps strict construction filesystem-free until daemon ownership and async preflight', async () => {
    const root = await temp('byok-strict-construction-');
    const hostStorageRoot = path.join(root, 'not-created-yet');
    daemon = createDaemonWithAdapters({
      localAgentRelease: { version: '0.0.0-test' },
      productName: 'Strict test',
      productId: `strict-construction-${path.basename(root)}`,
      serverUrl: server.url,
      workspaceRoot: path.join(root, 'workspace'),
      storeDir: path.join(root, 'store'),
      agentHome: { hostStorageRoot },
      strictAgentOnly: true,
    }, [new StubRuntimeAdapter('pi')]);

    await expect(fs.lstat(hostStorageRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.lstat(path.join(root, 'store'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('declines both legacy offer variants after receive while producing no runtime side effects', async () => {
    const adapter = await startStrict();
    server.send(createEnvelope('task.offer', { instruction: 'legacy', policy: { mode: 'auto' } }, { taskId: 'strict-legacy', seq: server.nextSeq() }));
    server.send(createEnvelope('task.offer_with_toolsets', {
      instruction: 'legacy tools', policy: { mode: 'auto' }, requiredToolsets: ['salesko'],
    }, { taskId: 'strict-toolset', seq: server.nextSeq() }));
    for (const taskId of ['strict-legacy', 'strict-toolset']) {
      const decline = await server.waitFor((entry) => entry.type === 'task.decline' && entry.task_id === taskId);
      expect(decline.payload).toMatchObject({ retryable: false });
      expect((decline.payload as { reason: string }).reason).toMatch(/strict Agent-only/i);
    }
    expect(adapter.sessions).toHaveLength(0);
    expect(server.received.some((entry) => ['task.claim', 'task.started', 'task.complete', 'task.fail', 'task.cancelled'].includes(entry.type))).toBe(false);
  });

  it('retains cancel and dedup precedence before strict legacy decline', async () => {
    const adapter = await startStrict();
    const cancelled = 'strict-pre-cancel';
    server.send(createEnvelope('task.cancel', { reason: 'operator cancelled first' }, { taskId: cancelled, seq: server.nextSeq() }));
    server.send(createEnvelope('task.offer', { instruction: 'legacy', policy: { mode: 'auto' } }, { taskId: cancelled, seq: server.nextSeq() }));
    const cancellationDecline = await server.waitFor((entry) => entry.type === 'task.decline' && entry.task_id === cancelled);
    expect((cancellationDecline.payload as { reason: string }).reason).toMatch(/cancelled before claim/i);

    const duplicate = createEnvelope('task.offer', { instruction: 'legacy', policy: { mode: 'auto' } }, { taskId: 'strict-duplicate', seq: server.nextSeq() });
    server.send(duplicate);
    await server.waitFor((entry) => entry.type === 'task.decline' && entry.task_id === 'strict-duplicate');
    server.send({ ...duplicate, seq: server.nextSeq() });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(server.received.filter((entry) => entry.type === 'task.decline' && entry.task_id === 'strict-duplicate')).toHaveLength(1);
    expect(adapter.sessions).toHaveLength(0);
  });

  it('continues to admit the Agent offer variants', async () => {
    const adapter = await startStrict();
    server.send(createEnvelope('task.offer_for_agent', {
      instruction: 'agent work', policy: { mode: 'auto' }, agentRef: { agentId: 'strict-agent', profileRevision: 'r1' },
    }, { taskId: 'strict-agent-offer', seq: server.nextSeq() }));
    await server.waitFor((entry) => entry.type === 'task.claim' && entry.task_id === 'strict-agent-offer');
    expect(adapter.sessions).toHaveLength(1);
  });
});

/** The missing-home case fails before this path is observed. */
function awaitablePath(): string { return path.join(os.tmpdir(), 'byok-strict-no-home-workspace'); }
