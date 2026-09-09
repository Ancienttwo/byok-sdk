import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createByokServer } from '@byok-sdk/server';
import type { AgentMessagePublishPayload } from '@byok-sdk/protocol';
import { startServer, stopServer } from '../../../server/src/__tests__/test-support';
import { createDaemonWithAdapters } from '@byok-sdk/client';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

it('runs two recurring executions through real HTTP and TaskRunner with distinct fresh sessions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-recurring-integration-'));
  const accepted: Array<{ taskId: string; payload: AgentMessagePublishPayload }> = [];
  const sdk = createByokServer({ productId: 'recurring-integration', longPollHoldMs: 50,
    agentMessage: { consume: async ({ taskId, payload }) => { accepted.push({ taskId, payload }); return { outcome: 'accepted' }; } } });
  const http = await startServer(sdk);
  const adapter = new StubRuntimeAdapter('pi');
  const daemon = createDaemonWithAdapters({
    localAgentRelease: { version: '0.0.0-recurring-test' }, productName: 'recurring test', productId: 'recurring-integration',
    serverUrl: http.baseUrl, workspaceRoot: path.join(root, 'workspace'), storeDir: path.join(root, 'store'),
    agentHome: { hostStorageRoot: path.join(root, 'home') }, agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },
  }, [adapter]);
  let releaseClose: (() => void) | undefined;
  try {
    const pairing = await sdk.pairing.createPairingCode({ productId: 'recurring-integration' });
    const { deviceId } = await daemon.pair(pairing.code);
    await daemon.start();
    await vi.waitFor(() => expect(daemon.status().connected).toBe(true));
    for (let index = 0; index < 2; index++) {
      const taskId = `recurring-${index}`;
      // Host context fixture; this test does not implement the product's transcript builder.
      const instruction = index === 0 ? 'U1' : 'U1\nA1\nU2';
      const input = { taskId, deviceId, payload: {
        instruction, runtime: 'pi' as const, policy: { mode: 'auto' as const },
        agentRef: { agentId: 'recurring-agent', profileRevision: 'profile-v1' },
        egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
        messageEgress: { mode: 'required' as const, contract: 'conversation-turn/v1', contentType: 'text/markdown' as const, maxBytes: 1024 },
        terminalProjection: { mode: 'none' as const },
      }, agentMessageContext: { destinationBinding: 'conversation', freshnessCursor: `turn-${index}` } };
      await sdk.recurring.submit(JSON.parse(JSON.stringify(input)));
      await vi.waitFor(async () => {
        const terminal = await sdk.tasks.deviceTerminal(taskId);
        if (terminal) throw new Error(JSON.stringify(terminal.envelope));
        expect(adapter.sessions).toHaveLength(index + 1);
      }, { timeout: 10000 });
      const session = adapter.sessions[index]!;
      expect(adapter.startCalls[index]?.task.sessionRef).toBeUndefined();
      expect(adapter.startCalls[index]?.task.instruction).toContain(instruction);
      releaseClose = session.blockClose();
      session.emit({ type: 'progress', text: `A${index + 1}` });
      session.emit({ type: 'turn_end' });
      await vi.waitFor(() => expect(accepted).toHaveLength(index + 1), { timeout: 10000 });
      await vi.waitFor(async () => expect(await sdk.tasks.deviceTerminal(taskId)).toMatchObject({ envelope: { type: 'task.complete' } }), { timeout: 10000 });
      expect(await sdk.tasks.messageDisposition(taskId, deviceId, accepted[index]!.payload)).toMatchObject({ outcome: 'accepted' });
      // Device terminal is visible while Session.close is still deliberately blocked.
      expect(daemon.status().activeTaskCount).toBeGreaterThan(0);
      releaseClose(); releaseClose = undefined;
      await vi.waitFor(() => expect(daemon.status().activeTaskCount).toBe(0));
    }
    expect(adapter.sessions[0]!.sessionRef).not.toBe(adapter.sessions[1]!.sessionRef);
    expect(accepted.map(item => item.payload.body)).toEqual(['A1', 'A2']);
  } finally {
    releaseClose?.();
    await daemon.stop(); sdk.stop(); await stopServer(http.server);
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30000);
