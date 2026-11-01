import { testScratchRoot } from "./fixtures/execution-scratch";
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createByokServer } from '@byok-sdk/server';
import type { AgentMessagePublishPlainPayload } from '@byok-sdk/protocol';
import { startServer, stopServer } from '../../../server/src/__tests__/test-support';
import { AgentHomeManager, createDaemonWithAdapters } from '@byok-sdk/client';
import { InMemoryDeviceCredentialStore } from './fixtures/device-credentials';
import { connectControlClient } from '../daemon/control-client';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { OPEN_LIFECYCLE } from './fixtures/lifecycle-barrier';

it('runs two recurring executions through real HTTP and TaskRunner with distinct fresh sessions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-execution-submit-integration-'));
  const accepted: Array<{ taskId: string; payload: AgentMessagePublishPlainPayload }> = [];
  const sdk = createByokServer({ productId: 'execution-submit-integration', longPollHoldMs: 50,
    agentMessage: { consume: async ({ taskId, payload }) => { accepted.push({ taskId, payload }); return { outcome: 'accepted' }; } } });
  const http = await startServer(sdk);
  const adapter = new StubRuntimeAdapter('pi');
  const daemon = createDaemonWithAdapters({ storage: { scratchRoot: testScratchRoot() },
    localAgentRelease: { version: '0.0.0-recurring-test' }, productName: 'recurring test', productId: 'execution-submit-integration',
    serverUrl: http.baseUrl, storeDir: path.join(root, 'store'),
    agentHome: { hostStorageRoot: path.join(root, 'home') }, agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },
  }, [adapter], { deviceCredentials: new InMemoryDeviceCredentialStore() });
  let releaseClose: (() => void) | undefined;
  try {
    const pairing = await sdk.pairing.createPairingCode({ productId: 'execution-submit-integration' });
    const { deviceId } = await daemon.pair(pairing.code);
    await daemon.start();
    await vi.waitFor(() => expect(daemon.status().lifecycle).toEqual(OPEN_LIFECYCLE));
    for (let index = 0; index < 2; index++) {
      const taskId = `recurring-${index}`;
      // Host context fixture; this test does not implement the product's transcript builder.
      const instruction = index === 0 ? 'U1' : 'U1\nA1\nU2';
      const input = { taskId, deviceId, payload: {
        instruction, runtime: 'pi' as const,
        agentRef: { agentId: 'recurring-agent', profileRevision: 'profile-v1' },
        session: { mode: 'fresh' as const }, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY,
        messageEgress: { mode: 'required' as const, contract: 'conversation-turn/v1', contentType: 'text/markdown' as const, maxBytes: 1024 },
        terminalProjection: { mode: 'none' as const },
      }, agentMessageContext: { destinationBinding: 'conversation', freshnessCursor: `turn-${index}` } };
      await sdk.executions.submit(JSON.parse(JSON.stringify(input)));
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
    await daemon.stop(); await sdk.close(); await stopServer(http.server);
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
  const selector = { mode: 'result-document' as const, contract: 'test.internal-summary.v1', schema: {
    type: 'object' as const, additionalProperties: false as const, required: ['schemaVersion', 'text'],
    properties: { schemaVersion: { const: 'test.internal-summary.v1' }, text: { type: 'string' as const, minLength: 1 } },
  } };
  const agentRef = { agentId: 'shared-summary-agent', profileRevision: 'profile-v1' };
  const frozenInstructions = new Map<string, string>();
  const precedingTurns = outcome === 'document' ? 1 : 0;
  // Synthetic model output, not a production Summary schema/quality assessment.
  const document = { schemaVersion: 'test.internal-summary.v1', text: 'User constraint: 中文 🐝, no external tools.' };
  const storeDir = path.join(root, 'store');
  const daemon = createDaemonWithAdapters({ storage: { scratchRoot: testScratchRoot() },
    localAgentRelease: { version: '0.0.0-summary-test' }, productName: 'summary test', productId: options.productId,
    serverUrl: http.baseUrl, storeDir,
    agentHome: { hostStorageRoot: path.join(root, 'home') }, agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },
    // A result-document offer is admitted only by a daemon that journals its terminals.
  }, [adapter], { deviceCredentials: new InMemoryDeviceCredentialStore() });
  /** The route the SDK result helper's submit_result forwards to. */
  const submit = async (index: number, value: unknown): Promise<unknown> => {
    const token = adapter.startCalls[index]?.ctx.mcpServers?.byokagentresult?.env?.BYOK_AGENT_RESULT_CONTEXT;
    if (!token) throw new Error('missing Agent result context');
    const connected = await connectControlClient({ storeDir, productId: options.productId });
    if (!connected.ok) throw new Error(connected.reason);
    try { return await connected.client.request('agent_results.submit', { contextToken: token, outcome: value }); }
    finally { connected.client.close(); }
  };
  let releaseClose: (() => void) | undefined;
  let daemonStopped = false;
  let httpStopped = false;
  try {
    const pairing = await sdk.pairing.createPairingCode({ productId: options.productId });
    const { deviceId } = await daemon.pair(pairing.code);
    await daemon.start();
    await vi.waitFor(() => expect(daemon.status().lifecycle).toEqual(OPEN_LIFECYCLE));
    if (precedingTurns) {
      const instruction = 'Remember the constraint: 中文 🐝, no external tools.';
      frozenInstructions.set('preceding-user-turn', instruction);
      await sdk.executions.submit({ taskId: 'preceding-user-turn', deviceId, payload: {
        agentRef, runtime: 'pi', instruction,
        session: { mode: 'fresh' as const }, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY, terminalProjection: { mode: 'none' },
        messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 1024 },
      }, agentMessageContext: { destinationBinding: 'conversation', freshnessCursor: 'preceding-turn' } });
      await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1), { timeout: 10000 });
      expect(adapter.startCalls[0]?.task.sessionRef).toBeUndefined();
      expect(adapter.startCalls[0]?.task.instruction).toContain(instruction);
      adapter.sessions[0]!.emit({ type: 'progress', text: 'Constraint retained.' });
      adapter.sessions[0]!.emit({ type: 'turn_end' });
      await vi.waitFor(async () => expect(await sdk.tasks.deviceTerminal('preceding-user-turn')).toMatchObject({
        envelope: { type: 'task.complete' },
      }), { timeout: 10000 });
      await vi.waitFor(() => expect(daemon.status().activeTaskCount).toBe(0));
      expect(messages).toEqual(['preceding-user-turn']);
    }
    const taskId = `summary-${outcome}`;
    const precedingMessage = precedingTurns ? await sdk.tasks.agentMessage('preceding-user-turn', deviceId, agentRef) : undefined;
    if (precedingTurns) expect(precedingMessage?.payload.body).toBe('Constraint retained.');
    // The Host supplies these complete bytes; no SDK transcript builder or Summary CAS is simulated.
    const summaryInstruction = precedingTurns
      ? JSON.stringify({ instruction: 'Summarize only this frozen historical input.',
        history: [{ input: frozenInstructions.get('preceding-user-turn'), reply: precedingMessage!.payload.body }] })
      : 'Summarize only this frozen historical input.';
    frozenInstructions.set(taskId, summaryInstruction);
    const input = { taskId, deviceId, payload: { agentRef, runtime: 'pi' as const,
      instruction: summaryInstruction,
      session: { mode: 'fresh' as const }, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY, terminalProjection: selector } };
    await sdk.executions.submit(input);
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(precedingTurns + 1), { timeout: 10000 });
    const session = adapter.sessions[precedingTurns]!;
    expect(adapter.startCalls[precedingTurns]?.task.sessionRef).toBeUndefined();
    expect(adapter.startCalls[precedingTurns]?.task.instruction).toContain(summaryInstruction);
    const offer = await sdk.tasks.offer(taskId);
    expect(offer).toMatchObject({ type: 'task.offer', payload: { agentRef, terminalProjection: selector } });
    expect(offer?.payload).toMatchObject({ session: { mode: 'fresh' } });
    expect((offer?.payload as { session: object } | undefined)?.session).not.toHaveProperty('sessionRef');
    expect(offer?.payload).not.toHaveProperty('messageEgress');
    releaseClose = session.blockClose();
    if (outcome === 'document') expect(await submit(precedingTurns, document)).toMatchObject({ state: 'staged' });
    // An outcome outside the frozen schema is refused and nothing is staged.
    if (outcome === 'invalid') expect(await submit(precedingTurns, { schemaVersion: 'other', text: '' })).toMatchObject({ state: 'rejected' });
    // Text that happens to be the document is never parsed into one.
    session.emit({ type: 'progress', text: JSON.stringify(document) });
    session.emit({ type: 'turn_end' });
    await vi.waitFor(async () => expect(await sdk.tasks.deviceTerminal(taskId)).toMatchObject({
      envelope: { type: outcome === 'document' ? 'task.complete' : 'task.fail' },
    }), { timeout: 10000 });
    const terminal = await sdk.tasks.deviceTerminal(taskId);
    expect(adapter.startCalls[precedingTurns]?.ctx.mcpServers?.byokagentresult).toBeDefined();
    expect(messages).toEqual(precedingTurns ? ['preceding-user-turn'] : []);
    expect(await sdk.tasks.agentMessage(taskId, deviceId, agentRef)).toBeUndefined();
    expect(daemon.status().activeTaskCount).toBeGreaterThan(0);
    if (outcome === 'document') {
      expect(terminal).toMatchObject({ envelope: { payload: { document } } });
      // Deliberate competing probe, not Host scheduling or automatic retry.
      // #476: an offer for the same home that arrives while the Summary's
      // Session.close() is held waits for that finishing Attempt instead of
      // being declined busy, and no second writer starts until close resolves.
      // The daemon's busy gate is its only reader of this count, so a call
      // proves the competing offer reached admission before close is released.
      const leaseManagerPrototype = Object.getPrototypeOf(
        new AgentHomeManager({ hostStorageRoot: path.join(root, 'probe-home') }).executionLeaseManager,
      ) as { activeAttemptCount(canonicalHome: string, homeAccess: string): number };
      const admissionCounts = vi.spyOn(leaseManagerPrototype, 'activeAttemptCount');
      frozenInstructions.set('competing-before-close', summaryInstruction);
      await sdk.executions.submit({ ...input, taskId: 'competing-before-close' });
      await vi.waitFor(async () => expect(await sdk.tasks.offer('competing-before-close')).toMatchObject({ delivered: true }),
        { timeout: 10000 });
      await vi.waitFor(() => expect(admissionCounts).toHaveBeenCalled(), { timeout: 10000 });
      admissionCounts.mockRestore();
      expect(await sdk.tasks.deviceTerminal('competing-before-close')).toBeUndefined();
      expect(adapter.sessions).toHaveLength(precedingTurns + 1);
      expect(adapter.startCalls).toHaveLength(precedingTurns + 1);
    } else {
      expect(terminal).toMatchObject({ envelope: { payload: { retryable: false, reason: expect.stringContaining('result_not_submitted') } } });
      expect(terminal?.envelope.payload).not.toHaveProperty('document');
    }
    releaseClose(); releaseClose = undefined;
    if (outcome === 'document') {
      // The parked competing offer is admitted once the Summary released the home.
      await vi.waitFor(() => expect(adapter.sessions).toHaveLength(precedingTurns + 2), { timeout: 10000 });
      expect(adapter.startCalls).toHaveLength(precedingTurns + 2);
      expect(adapter.startCalls[precedingTurns + 1]?.task.sessionRef).toBeUndefined();
      expect(adapter.startCalls[precedingTurns + 1]?.ctx.workspaceDir).toBe(adapter.startCalls[precedingTurns]?.ctx.workspaceDir);
      const competingSession = adapter.sessions[precedingTurns + 1]!;
      expect(await submit(precedingTurns + 1, document)).toMatchObject({ state: 'staged' });
      competingSession.emit({ type: 'progress', text: JSON.stringify(document) });
      competingSession.emit({ type: 'turn_end' });
      await vi.waitFor(async () => expect(await sdk.tasks.deviceTerminal('competing-before-close')).toMatchObject({
        envelope: { type: 'task.complete', payload: { document } },
      }), { timeout: 10000 });
    }
    await vi.waitFor(() => expect(daemon.status().activeTaskCount).toBe(0));
    if (outcome === 'document') {
      if (terminal?.envelope.type !== 'task.complete' || terminal.envelope.payload.sealed !== undefined) throw new Error('Missing Summary terminal');
      const recoveredDocument = terminal.envelope.payload.document;
      expect(recoveredDocument).toEqual(document);
      const instruction = JSON.stringify({ summary: recoveredDocument, recentHistory: [], input: 'Current user request' });
      frozenInstructions.set('dependent-user-turn', instruction);
      // New explicit user execution after Summary, not a retry of the competing probe.
      await sdk.executions.submit({ taskId: 'dependent-user-turn', deviceId, payload: {
        agentRef, runtime: 'pi', instruction,
        session: { mode: 'fresh' as const }, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY, terminalProjection: { mode: 'none' },
        messageEgress: { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 1024 },
      }, agentMessageContext: { destinationBinding: 'conversation', freshnessCursor: 'user-turn' } });
      await vi.waitFor(() => expect(adapter.sessions).toHaveLength(precedingTurns + 3), { timeout: 10000 });
      const dependentSession = adapter.sessions[precedingTurns + 2]!;
      expect(adapter.startCalls[precedingTurns + 2]?.task.sessionRef).toBeUndefined();
      expect(adapter.startCalls[precedingTurns + 2]?.task.instruction).toContain(instruction);
      expect(new Set(adapter.sessions.map(item => item.sessionRef)).size).toBe(4);
      expect(new Set(adapter.startCalls.map(item => item.ctx.workspaceDir)).size).toBe(1);
      dependentSession.emit({ type: 'progress', text: 'User answer' });
      dependentSession.emit({ type: 'turn_end' });
      await vi.waitFor(async () => expect(await sdk.tasks.deviceTerminal('dependent-user-turn')).toMatchObject({
        envelope: { type: 'task.complete' },
      }), { timeout: 10000 });
      await vi.waitFor(() => expect(daemon.status().activeTaskCount).toBe(0));
      expect(messages).toEqual(['preceding-user-turn', 'dependent-user-turn']);
      // The Summary and the competing probe each carried the result-document channel; user turns did not.
      expect(adapter.startCalls.map(item => item.ctx.mcpServers?.byokagentresult !== undefined))
        .toEqual([false, true, true, false]);
    }
    await daemon.stop(); daemonStopped = true;
    await stopServer(http.server); httpStopped = true;
    await sdk.close();
    sdk = createByokServer(options);
    expect(await sdk.tasks.deviceTerminal(taskId)).toEqual(terminal);
    expect(await sdk.tasks.offer(taskId)).toEqual(offer);
    for (const [id, instruction] of frozenInstructions) {
      const recoveredOffer = await sdk.tasks.offer(id);
      if (!recoveredOffer || !('instruction' in recoveredOffer.payload)
        || typeof recoveredOffer.payload.instruction !== 'string') throw new Error(`Missing frozen instruction: ${id}`);
      expect(Buffer.from(recoveredOffer.payload.instruction)).toEqual(Buffer.from(instruction));
    }
    expect(await sdk.tasks.agentMessage(taskId, deviceId, agentRef)).toBeUndefined();
    if (precedingTurns) {
      expect(await sdk.tasks.agentMessage('preceding-user-turn', deviceId, agentRef)).toEqual(precedingMessage);
      expect((await sdk.tasks.agentMessage('dependent-user-turn', deviceId, agentRef))?.payload.body).toBe('User answer');
    }
    expect(await sdk.tasks.deviceTerminal('nonexistent-summary')).toBeUndefined();
    expect(adapter.sessions).toHaveLength(outcome === 'document' ? 4 : 1);
  } finally {
    releaseClose?.();
    if (!daemonStopped) await daemon.stop();
    if (!httpStopped) await stopServer(http.server);
    await sdk.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 45000);
