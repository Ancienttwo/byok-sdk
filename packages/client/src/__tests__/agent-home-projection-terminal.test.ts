import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { RuntimeExecutionFailure } from '../runtime-failure';
import { AGENT_HOME_PROJECTION_STATE_FILE, AgentHomeManager, createAgentHomeProjectionConsumer } from '../agent-home';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { TestServer } from './fixtures/test-server';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

const HASH_3 = `sha256:${'3'.repeat(64)}`;
const consumer = createAgentHomeProjectionConsumer(() => {});

async function temp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Apply revision 3 of the persona for `agentId`, as `agent.home_projection` would. */
async function applyProjection(hostStorageRoot: string, agentId: string): Promise<void> {
  const manager = new AgentHomeManager({ hostStorageRoot, projection: consumer });
  await expect(manager.project({
    requestId: '00000000-0000-4000-8000-000000000003',
    agentRef: { agentId, profileRevision: '3' },
    projectionHash: HASH_3,
    projection: { schemaVersion: 'host.opaque.v1', displayName: 'Persona 3' },
  })).resolves.toBe('applied');
}

describe('terminal evidence of the applied Agent-home projection (#318)', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  beforeEach(async () => { server = await TestServer.start(); });
  afterEach(async () => {
    await daemon?.stop();
    await server.close();
  });

  async function start(hostStorageRoot: string): Promise<StubRuntimeAdapter> {
    const storeDir = await temp('byok-projection-terminal-store-');
    const adapter = new StubRuntimeAdapter('pi');
    daemon = createDaemonWithAdapters({
      localAgentRelease: { version: '0.0.0-test' },
      productName: 'Projection terminal test',
      productId: `projection-terminal-${path.basename(storeDir)}`,
      serverUrl: server.url,
      storeDir,
      agentHome: { hostStorageRoot, projection: consumer },
      strictAgentOnly: true,
    }, [adapter]);
    await daemon.pair('pairing-code');
    await daemon.start();
    await server.waitFor((entry) => entry.type === 'conn.hello');
    return adapter;
  }

  function offer(taskId: string, agentId: string, profileRevision: string): void {
    server.send(createEnvelope('task.offer_for_agent', {
      instruction: 'agent work', agentRef: { agentId, profileRevision },
    }, { taskId, seq: server.nextSeq() }));
  }

  it('reports the applied revision and hash next to a newer offer revision on task.complete', async () => {
    const hostStorageRoot = await temp('byok-projection-terminal-home-');
    await applyProjection(hostStorageRoot, 'persona-agent');
    const adapter = await start(hostStorageRoot);

    offer('newer-offer', 'persona-agent', '4');
    await server.waitFor((entry) => entry.type === 'task.claim' && entry.task_id === 'newer-offer');
    adapter.sessions[0]!.emit({ type: 'progress', text: 'done' });
    adapter.sessions[0]!.emit({ type: 'turn_end' });

    const complete = await server.waitFor((entry) => entry.type === 'task.complete' && entry.task_id === 'newer-offer');
    expect(complete.payload).toMatchObject({
      agentRef: { agentId: 'persona-agent', profileRevision: '4' },
      agentHomeProjection: { profileRevision: '3', projectionHash: HASH_3 },
    });
  });

  it('reports the applied projection on task.fail', async () => {
    const hostStorageRoot = await temp('byok-projection-terminal-home-');
    await applyProjection(hostStorageRoot, 'persona-agent');
    const adapter = await start(hostStorageRoot);

    offer('failing-offer', 'persona-agent', '3');
    await server.waitFor((entry) => entry.type === 'task.claim' && entry.task_id === 'failing-offer');
    adapter.sessions[0]!.fail(new RuntimeExecutionFailure({
      phase: 'run', category: 'semantic', retry: 'non-retryable', reason: 'runtime ended with failure',
    }));

    const failed = await server.waitFor((entry) => entry.type === 'task.fail' && entry.task_id === 'failing-offer');
    expect(failed.payload).toMatchObject({ agentHomeProjection: { profileRevision: '3', projectionHash: HASH_3 } });
  });

  it('reports the applied projection on task.cancelled', async () => {
    const hostStorageRoot = await temp('byok-projection-terminal-home-');
    await applyProjection(hostStorageRoot, 'persona-agent');
    await start(hostStorageRoot);

    offer('cancelled-offer', 'persona-agent', '3');
    await server.waitFor((entry) => entry.type === 'task.claim' && entry.task_id === 'cancelled-offer');
    server.send(createEnvelope('task.cancel', { reason: 'host stop' }, { taskId: 'cancelled-offer', seq: server.nextSeq() }));

    const cancelled = await server.waitFor((entry) => entry.type === 'task.cancelled' && entry.task_id === 'cancelled-offer');
    expect(cancelled.payload).toMatchObject({ agentHomeProjection: { profileRevision: '3', projectionHash: HASH_3 } });
  });

  it('runs the Attempt and omits the evidence when the projection record is unreadable', async () => {
    const hostStorageRoot = await temp('byok-projection-terminal-home-');
    await applyProjection(hostStorageRoot, 'persona-agent');
    const record = path.join(await fs.realpath(hostStorageRoot), 'agents', 'persona-agent', '.byok', AGENT_HOME_PROJECTION_STATE_FILE);
    await fs.writeFile(record, '{corrupt', 'utf8');
    const adapter = await start(hostStorageRoot);

    offer('corrupt-record', 'persona-agent', '3');
    await server.waitFor((entry) => entry.type === 'task.claim' && entry.task_id === 'corrupt-record');
    adapter.sessions[0]!.emit({ type: 'turn_end' });

    const complete = await server.waitFor((entry) => entry.type === 'task.complete' && entry.task_id === 'corrupt-record');
    expect(Object.hasOwn(complete.payload, 'agentHomeProjection')).toBe(false);
  });

  it('omits the field when the home has no applied projection', async () => {
    const adapter = await start(await temp('byok-projection-terminal-home-'));

    offer('no-projection', 'fresh-agent', '1');
    await server.waitFor((entry) => entry.type === 'task.claim' && entry.task_id === 'no-projection');
    adapter.sessions[0]!.emit({ type: 'turn_end' });

    const complete = await server.waitFor((entry) => entry.type === 'task.complete' && entry.task_id === 'no-projection');
    expect(Object.hasOwn(complete.payload, 'agentHomeProjection')).toBe(false);
  });
});
