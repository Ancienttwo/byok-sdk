import { testScratchRoot } from './fixtures/execution-scratch';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { AGENT_HOME_DIRECTORY } from '../agent-home';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import { TestServer } from './fixtures/test-server';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

// Replaces the removed daemon-session-resume.test.ts (#925). A writer
// session's handoff lives in its Agent home, so a resume finds it after the
// daemon process is replaced.

async function temp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe('Agent writer session resume across a daemon restart', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    await server.close();
  });

  it('resumes a writer session in the same Agent home after the daemon restarts on the same store and home root', async () => {
    server = await TestServer.start();
    const storeDir = await temp('byok-writer-resume-store-');
    const hostStorageRoot = await temp('byok-writer-resume-home-');
    const agentRef = { agentId: 'writer-restart', profileRevision: 'r1' };
    const config = {
      storage: { scratchRoot: testScratchRoot() }, localAgentRelease: { version: '0.0.0-test' },
      productName: 'Writer resume', productId: 'writer-resume', serverUrl: server.url, storeDir, agentHome: { hostStorageRoot },
    };
    const offer = (taskId: string, sessionRef?: string) => server.send(createEnvelope('task.offer_for_agent', {
      instruction: taskId, agentRef, runtime: 'pi', ...(sessionRef === undefined ? {} : { sessionRef }),
    }, { taskId, seq: server.nextSeq() }));

    const first = new StubRuntimeAdapter('pi');
    daemon = createDaemonWithAdapters(config, [first]);
    await daemon.pair('pairing-code');
    await daemon.start();
    offer('writer-first');
    await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'writer-first');
    expect(first.startCalls[0]!.task.sessionRef).toBeUndefined();
    first.sessions[0]!.emit({ type: 'turn_end' });
    const complete = await server.waitFor((e) => e.type === 'task.complete' && e.task_id === 'writer-first');
    const sessionRef = (complete.payload as { sessionRef: string }).sessionRef;
    expect(sessionRef).toBe(first.sessions[0]!.sessionRef);
    await daemon.stop();

    // A new daemon process: same storeDir and Agent home root, no re-pair.
    const second = new StubRuntimeAdapter('pi');
    daemon = createDaemonWithAdapters(config, [second]);
    await daemon.start();
    offer('writer-resumed', sessionRef);
    await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'writer-resumed');

    const home = path.join(await fs.realpath(hostStorageRoot), AGENT_HOME_DIRECTORY, agentRef.agentId);
    expect(second.startCalls[0]!.task.sessionRef).toBe(sessionRef);
    expect(second.startCalls[0]!.ctx.workspaceDir).toBe(first.startCalls[0]!.ctx.workspaceDir);
    expect(second.startCalls[0]!.ctx.workspaceDir).toBe(home);
    await expect(new AgentSessionHandoffStore().requireMatch({ agentRef, sessionRef, runtimeId: 'pi', cwd: home }))
      .resolves.toMatchObject({ taskId: 'writer-resumed', sessionRef });
  });
});
