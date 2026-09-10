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

it.each(['document', 'missing', 'invalid'] as const)('persists strict fresh Summary %s without the chat slot', async (outcome) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-summary-integration-'));
  const messages: string[] = [];
  const options = { productId: 'summary-integration', longPollHoldMs: 50,
    storage: { kind: 'sqlite' as const, path: path.join(root, 'server.sqlite') },
    agentMessage: { consume: async ({ taskId }: { taskId: string }) => {
      messages.push(taskId); return { outcome: 'accepted' as const };
    } } };
  let sdk = createByokServer(options);
  const http = await startServer(sdk);
  const adapter = new StubRuntimeAdapter('pi');
  const selector = { mode: 'result-document' as const, contract: 'test.internal-summary.v1' };
  const agentRef = { agentId: 'shared-summary-agent', profileRevision: 'profile-v1' };
  // Synthetic model output, not a production Summary schema/quality assessment.
  const document = { schemaVersion: 'test.internal-summary.v1', text: 'Canceled request remains historical, not authorized.' };
  const extracts: Array<{ taskId: string; sessionRef: string; terminalProjection?: unknown }> = [];
  const daemon = createDaemonWithAdapters({
    localAgentRelease: { version: '0.0.0-summary-test' }, productName: 'summary test', productId: options.productId,
    serverUrl: http.baseUrl, workspaceRoot: path.join(root, 'workspace'), storeDir: path.join(root, 'store'),
    agentHome: { hostStorageRoot: path.join(root, 'home') }, agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },
    resultDocument: { extract: (output, task) => {
      extracts.push(task);
      if (task.terminalProjection?.mode !== selector.mode || task.terminalProjection.contract !== selector.contract) {
        throw new Error('Unexpected internal result contract');
      }
      if (outcome === 'missing') return undefined;
      return JSON.parse(output);
    } },
  }, [adapter]);
  let releaseClose: (() => void) | undefined;
  let daemonStopped = false;
  let httpStopped = false;
  try {
    const pairing = await sdk.pairing.createPairingCode({ productId: options.productId });
    const { deviceId } = await daemon.pair(pairing.code);
    await daemon.start();
    await vi.waitFor(() => expect(daemon.status().connected).toBe(true));
    const taskId = `summary-${outcome}`;
    const input = { taskId, deviceId, agentRef, runtime: 'pi' as const, policy: { mode: 'auto' as const },
      instruction: 'Summarize only this frozen historical input.',
      egressPolicy: DEFAULT_AGENT_EGRESS_POLICY, terminalProjection: selector };
    await sdk.dispatchFreshAgentEgress(input);
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), { timeout: 10000 });
    const session = adapter.sessions[0]!;
    expect(adapter.startCalls[0]?.task.sessionRef).toBeUndefined();
    const offer = await sdk.tasks.offer(taskId);
    expect(offer).toMatchObject({ type: 'task.offer_for_agent_with_egress_fresh', payload: { agentRef, terminalProjection: selector } });
    expect(offer?.payload).not.toHaveProperty('sessionRef');
    expect(offer?.payload).not.toHaveProperty('messageEgress');
    releaseClose = session.blockClose();
    session.emit({ type: 'progress', text: outcome === 'invalid' ? '{invalid-json' : JSON.stringify(document) });
    session.emit({ type: 'turn_end' });
    await vi.waitFor(async () => expect(await sdk.tasks.deviceTerminal(taskId)).toMatchObject({
      envelope: { type: outcome === 'document' ? 'task.complete' : 'task.fail' },
    }), { timeout: 10000 });
    const terminal = await sdk.tasks.deviceTerminal(taskId);
    expect(extracts).toEqual([{ taskId, sessionRef: session.sessionRef, terminalProjection: selector }]);
    expect(messages).toEqual([]);
    expect(daemon.status().activeTaskCount).toBeGreaterThan(0);
    if (outcome === 'document') {
      expect(terminal).toMatchObject({ envelope: { payload: { document } } });
      // Deliberate competing probe, not Host scheduling or automatic retry.
      await sdk.dispatchFreshAgentEgress({ ...input, taskId: 'competing-before-close' });
      await vi.waitFor(async () => expect(await sdk.tasks.deviceTerminal('competing-before-close')).toMatchObject({
        envelope: { type: 'task.decline', payload: { retryable: true } },
      }), { timeout: 10000 });
      expect(adapter.sessions).toHaveLength(1);
      expect(adapter.startCalls).toHaveLength(1);
    } else {
      expect(terminal).toMatchObject({ envelope: { payload: { retryable: false } } });
      expect(terminal?.envelope.payload).not.toHaveProperty('document');
    }
    releaseClose(); releaseClose = undefined;
    await vi.waitFor(() => expect(daemon.status().activeTaskCount).toBe(0));
    if (outcome === 'document') {
      // New explicit user execution after Summary, not a retry of the decline.
      await sdk.recurring.submit({ taskId: 'dependent-user-turn', deviceId, payload: {
        agentRef, runtime: 'pi', policy: { mode: 'auto' }, instruction: `${document.text}\nCurrent user request`,
        egressPolicy: DEFAULT_AGENT_EGRESS_POLICY, terminalProjection: { mode: 'none' },
        messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 1024 },
      }, agentMessageContext: { destinationBinding: 'conversation', freshnessCursor: 'user-turn' } });
      await vi.waitFor(() => expect(adapter.sessions).toHaveLength(2), { timeout: 10000 });
      expect(adapter.startCalls[1]?.task.sessionRef).toBeUndefined();
      expect(adapter.sessions[1]!.sessionRef).not.toBe(session.sessionRef);
      adapter.sessions[1]!.emit({ type: 'progress', text: 'User answer' });
      adapter.sessions[1]!.emit({ type: 'turn_end' });
      await vi.waitFor(async () => expect(await sdk.tasks.deviceTerminal('dependent-user-turn')).toMatchObject({
        envelope: { type: 'task.complete' },
      }), { timeout: 10000 });
      await vi.waitFor(() => expect(daemon.status().activeTaskCount).toBe(0));
      expect(messages).toEqual(['dependent-user-turn']);
      expect(extracts).toHaveLength(1);
    }
    await daemon.stop(); daemonStopped = true;
    await stopServer(http.server); httpStopped = true;
    await sdk.close();
    sdk = createByokServer(options);
    expect(await sdk.tasks.deviceTerminal(taskId)).toEqual(terminal);
    expect(await sdk.tasks.offer(taskId)).toEqual(offer);
    expect(await sdk.tasks.deviceTerminal('nonexistent-summary')).toBeUndefined();
    expect(adapter.sessions).toHaveLength(outcome === 'document' ? 2 : 1);
  } finally {
    releaseClose?.();
    if (!daemonStopped) await daemon.stop();
    if (!httpStopped) await stopServer(http.server);
    await sdk.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 45000);
