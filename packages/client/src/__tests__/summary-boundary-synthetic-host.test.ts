import { createHash } from 'node:crypto';
import { testScratchRoot } from './fixtures/execution-scratch';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createByokServer } from '@byok-sdk/server';
import type { AgentMessagePublishPayload } from '@byok-sdk/protocol';
import { startServer, stopServer } from '../../../server/src/__tests__/test-support';
import { createDaemonWithAdapters } from '@byok-sdk/client';
import { testDeviceCredentials } from './fixtures/device-credentials';
import { connectControlClient } from '../bin/control-client';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { OPEN_LIFECYCLE } from './fixtures/lifecycle-barrier';

// #195 S2: a synthetic Host. Everything Host-owned below (transcript,
// Summary, SummaryJob, CAS, ContextPack) lives only in this file; the SDK is
// exercised through its public server surfaces. Source-level evidence, not
// Host acceptance. Wire v3 (K7): the Summary is a result-document offer with
// a frozen schema; the runtime submits it through the daemon's submit_result
// route, never as text the Host or SDK parses.

type TurnOutcome =
  | { kind: 'reply'; text: string; executionTerminal: 'task.complete' | 'task.fail' | 'task.cancelled' }
  | { kind: 'settled-without-reply'; executionTerminal: 'task.fail'; reason: string; retryable: boolean | undefined };
interface Turn { seq: number; taskId: string; input: string; outcome: TurnOutcome }
interface Summary { version: number; coveredThroughTurnSeq: number; text: string }
interface SummaryJob { jobId: string; baseVersion: number; baseCoveredThrough: number; targetCoveredThrough: number; taskId: string }
interface SummaryDocument { schemaVersion: 'synthetic-host.summary.v1'; jobId: string; coveredThroughTurnSeq: number; text: string }
interface ContextPack { summary: Summary; recentHistory: Turn[]; input: string }
type ApplyResult = 'applied' | 'replayed' | 'stale';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

class SyntheticHost {
  readonly transcript: Turn[] = [];
  summary: Summary = { version: 0, coveredThroughTurnSeq: 0, text: '' };
  readonly jobs = new Map<string, SummaryJob>();
  /** Exact bytes frozen per task, kept independently of any SDK readback. */
  readonly frozen = new Map<string, { bytes: Buffer; sha256: string }>();
  private readonly applied = new Map<string, string>();

  freeze(taskId: string, value: unknown): string {
    if (this.frozen.has(taskId)) throw new Error(`synthetic Host: ${taskId} is already frozen`);
    const text = JSON.stringify(value);
    const bytes = Buffer.from(text, 'utf8');
    this.frozen.set(taskId, { bytes, sha256: sha256(bytes) });
    return text;
  }

  contextPack(input: string): ContextPack {
    const covered = this.summary.coveredThroughTurnSeq;
    return { summary: { ...this.summary }, recentHistory: this.transcript.filter(turn => turn.seq > covered), input };
  }

  settle(turn: Turn): void {
    if (turn.seq !== this.transcript.length + 1) throw new Error('synthetic Host: transcript is append-only');
    this.transcript.push(turn);
  }

  createJob(jobId: string, targetCoveredThrough: number): SummaryJob {
    const job = { jobId, baseVersion: this.summary.version, baseCoveredThrough: this.summary.coveredThroughTurnSeq,
      targetCoveredThrough, taskId: `summary-${jobId}` };
    this.jobs.set(jobId, job);
    return job;
  }

  summaryInput(job: SummaryJob): { job: SummaryJob; baseSummaryText: string; turns: Turn[] } {
    if (job.baseVersion !== this.summary.version) throw new Error('synthetic Host: job input frozen against an old base');
    return { job, baseSummaryText: this.summary.text,
      turns: this.transcript.filter(turn => turn.seq > job.baseCoveredThrough && turn.seq <= job.targetCoveredThrough) };
  }

  /** CAS: coverage and version move only from the job's exact base. */
  apply(job: SummaryJob, document: SummaryDocument): ApplyResult {
    const digest = sha256(Buffer.from(JSON.stringify(document)));
    const prior = this.applied.get(job.jobId);
    if (prior !== undefined) {
      if (prior !== digest) throw new Error('synthetic Host: conflicting result for an applied job');
      return 'replayed';
    }
    if (document.jobId !== job.jobId || document.coveredThroughTurnSeq !== job.targetCoveredThrough) {
      throw new Error('synthetic Host: Summary document does not match its job');
    }
    if (job.baseVersion !== this.summary.version || job.targetCoveredThrough <= this.summary.coveredThroughTurnSeq) return 'stale';
    this.summary = { version: this.summary.version + 1, coveredThroughTurnSeq: job.targetCoveredThrough, text: document.text };
    this.applied.set(job.jobId, digest);
    return 'applied';
  }
}

/** Summary coverage plus recentHistory is exactly every settled turn before `currentSeq`: no hole, no duplicate. */
function expectContiguous(pack: ContextPack, currentSeq: number, transcript: Turn[]): void {
  const covered = Array.from({ length: pack.summary.coveredThroughTurnSeq }, (_, index) => index + 1);
  const settled = transcript.filter(turn => turn.seq < currentSeq).map(turn => turn.seq);
  expect(settled).toEqual(Array.from({ length: currentSeq - 1 }, (_, index) => index + 1));
  expect([...covered, ...pack.recentHistory.map(turn => turn.seq)]).toEqual(settled);
}

it('synthetic Host: ContextPack turns cross Summary updates with CAS, replay, stale-job and restart faults', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-summary-boundary-'));
  const accepted: Array<{ taskId: string; body: string }> = [];
  const options = { productId: 'summary-boundary', longPollHoldMs: 50,
    storage: { kind: 'sqlite' as const, path: path.join(root, 'server.sqlite') },
    agentMessage: { consume: async ({ taskId, payload }: { taskId: string; payload: AgentMessagePublishPayload }) => {
      accepted.push({ taskId, body: payload.body }); return { outcome: 'accepted' as const };
    } } };
  let sdk = createByokServer(options);
  const http = await startServer(sdk);
  const adapter = new StubRuntimeAdapter('pi');
  const selector = { mode: 'result-document' as const, contract: 'synthetic-host.summary.v1', schema: {
    type: 'object' as const, additionalProperties: false as const,
    required: ['schemaVersion', 'jobId', 'coveredThroughTurnSeq', 'text'],
    properties: {
      schemaVersion: { const: 'synthetic-host.summary.v1' },
      jobId: { type: 'string' as const, minLength: 1 },
      coveredThroughTurnSeq: { type: 'integer' as const, minimum: 0 },
      text: { type: 'string' as const },
    },
  } };
  const agentRef = { agentId: 'summary-boundary-agent', profileRevision: 'profile-v1' };
  const storeDir = path.join(root, 'store');
  const daemon = createDaemonWithAdapters({
    storage: { scratchRoot: testScratchRoot() },
    localAgentRelease: { version: '0.0.0-summary-boundary-test' }, productName: 'summary boundary test', productId: options.productId,
    serverUrl: http.baseUrl, storeDir,
    agentHome: { hostStorageRoot: path.join(root, 'home') }, agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },
    // A result-document offer is admitted only by a daemon that journals its terminals.
  }, [adapter], { deviceCredentials: testDeviceCredentials(options.productId) });
  const host = new SyntheticHost();
  const summaryTaskIds: string[] = [];
  let daemonStopped = false;
  let httpStopped = false;
  try {
    const pairing = await sdk.pairing.createPairingCode({ productId: options.productId });
    const { deviceId } = await daemon.pair(pairing.code);
    await daemon.start();
    await vi.waitFor(() => expect(daemon.status().lifecycle).toEqual(OPEN_LIFECYCLE));

    const expectFrozenOffer = async (taskId: string) => {
      const offer = await sdk.tasks.offer(taskId);
      if (!offer || !('instruction' in offer.payload) || typeof offer.payload.instruction !== 'string') {
        throw new Error(`synthetic Host: missing frozen instruction for ${taskId}`);
      }
      const bytes = Buffer.from(offer.payload.instruction, 'utf8');
      expect(bytes).toEqual(host.frozen.get(taskId)!.bytes);
      expect(sha256(bytes)).toBe(host.frozen.get(taskId)!.sha256);
      return offer;
    };
    const settledTerminal = async (taskId: string, type: 'task.complete' | 'task.fail' | 'task.cancelled') => {
      await vi.waitFor(async () => expect(await sdk.tasks.deviceTerminal(taskId)).toMatchObject({ envelope: { type } }), { timeout: 10000 });
      await vi.waitFor(() => expect(daemon.status().activeTaskCount).toBe(0));
      return (await sdk.tasks.deviceTerminal(taskId))!;
    };

    const runUserTurn = async (input: string, mode: 'reply' | 'no-reply' | 'reply-then-fail' | 'reply-then-cancel') => {
      const seq = host.transcript.length + 1;
      const taskId = `user-turn-${seq}`;
      const pack = host.contextPack(input);
      expectContiguous(pack, seq, host.transcript);
      const instruction = host.freeze(taskId, pack);
      const index = adapter.sessions.length;
      const messageEgress = { mode: 'required', contract: 'conversation-turn/v1', contentType: 'text/markdown', maxBytes: 1024 } as const;
      const enqueued = await sdk.executions.submit({ taskId, deviceId, payload: {
        agentRef, runtime: 'pi', instruction,
        session: { mode: 'fresh' as const }, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY, terminalProjection: { mode: 'none' }, messageEgress,
      }, agentMessageContext: { destinationBinding: 'conversation', freshnessCursor: `turn-${seq}` } });
      expect(enqueued).toMatchObject({ taskId, envelope: { type: 'task.offer' } });
      await vi.waitFor(() => expect(adapter.sessions).toHaveLength(index + 1), { timeout: 10000 });
      expect(adapter.startCalls[index]?.task.sessionRef).toBeUndefined();
      expect(adapter.startCalls[index]?.task.instruction).toContain(instruction);
      // User turns and SummaryJobs share the one fresh submit path; only the projection/egress differ.
      const offer = await expectFrozenOffer(taskId);
      expect(offer).toMatchObject({ type: 'task.offer',
        payload: { agentRef, terminalProjection: { mode: 'none' }, messageEgress } });
      // B2: the fresh offer has no `sessionRef` member -> its `session` is `{ mode: 'fresh' }` and names no `sessionRef`
      expect(offer.payload).toMatchObject({ session: { mode: 'fresh' } });
      expect(offer.payload.session).not.toHaveProperty('sessionRef');
      const session = adapter.sessions[index]!;
      const reply = `A${seq}`;
      let outcome: TurnOutcome;
      if (mode === 'reply') {
        session.emit({ type: 'progress', text: reply });
        session.emit({ type: 'turn_end' });
        await settledTerminal(taskId, 'task.complete');
        outcome = { kind: 'reply', text: reply, executionTerminal: 'task.complete' };
      } else if (mode === 'no-reply') {
        session.emit({ type: 'turn_end' });
        const terminal = await settledTerminal(taskId, 'task.fail');
        if (terminal.envelope.type !== 'task.fail') throw new Error('unreachable');
        expect(await sdk.tasks.agentMessage(taskId, deviceId, agentRef)).toBeUndefined();
        outcome = { kind: 'settled-without-reply', executionTerminal: 'task.fail',
          reason: terminal.envelope.payload.reason, retryable: terminal.envelope.payload.retryable };
      } else {
        // The runtime authors its reply through the same daemon control route
        // the shipped message helper uses, then the execution fails or the
        // Host cancels it.
        const token = adapter.startCalls[index]?.ctx.mcpServers?.byokagentmessage?.env?.BYOK_AGENT_MESSAGE_CONTEXT;
        if (!token) throw new Error('synthetic Host: missing Agent message context');
        const connected = await connectControlClient({ storeDir, productId: options.productId });
        if (!connected.ok) throw new Error(connected.reason);
        try {
          await connected.client.request('agent_messages.publish', { contextToken: token, contentType: 'text/markdown', body: reply });
        } finally { connected.client.close(); }
        await vi.waitFor(async () => expect(await sdk.tasks.agentMessage(taskId, deviceId, agentRef)).toMatchObject({
          payload: { body: reply }, disposition: { outcome: 'accepted' },
        }), { timeout: 10000 });
        if (mode === 'reply-then-fail') {
          session.fail(new Error('synthetic Host: runtime failed after its reply was accepted'));
          await settledTerminal(taskId, 'task.fail');
          outcome = { kind: 'reply', text: reply, executionTerminal: 'task.fail' };
        } else {
          // Host cancellation reaches the native session; the runtime ends the turn as an interrupt would.
          await sdk.tasks.cancel(taskId, 'synthetic Host: user cancelled after the reply was accepted');
          await vi.waitFor(() => expect(session.interruptCalled).toBe(true), { timeout: 10000 });
          session.emit({ type: 'turn_end' });
          await settledTerminal(taskId, 'task.cancelled');
          outcome = { kind: 'reply', text: reply, executionTerminal: 'task.cancelled' };
        }
      }
      if (outcome.kind === 'reply') {
        const message = await sdk.tasks.agentMessage(taskId, deviceId, agentRef);
        expect(message).toMatchObject({ payload: { body: reply }, disposition: { outcome: 'accepted' } });
        expect(await sdk.tasks.messageDisposition(taskId, deviceId, message!.payload)).toMatchObject({ outcome: 'accepted' });
      }
      host.settle({ seq, taskId, input, outcome });
      return pack;
    };

    const runSummary = async (job: SummaryJob, text: string) => {
      const input = host.summaryInput(job);
      expect(input.turns.map(turn => turn.seq)).toEqual(
        Array.from({ length: job.targetCoveredThrough - job.baseCoveredThrough }, (_, index) => job.baseCoveredThrough + index + 1));
      const instruction = host.freeze(job.taskId, input);
      const index = adapter.sessions.length;
      summaryTaskIds.push(job.taskId);
      const enqueued = await sdk.executions.submit({ taskId: job.taskId, deviceId, payload: {
        agentRef, runtime: 'pi', instruction, session: { mode: 'fresh' as const }, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY, terminalProjection: selector,
      } });
      expect(enqueued).toMatchObject({ taskId: job.taskId, envelope: { type: 'task.offer' } });
      await vi.waitFor(() => expect(adapter.sessions).toHaveLength(index + 1), { timeout: 10000 });
      expect(adapter.startCalls[index]?.task.sessionRef).toBeUndefined();
      expect(adapter.startCalls[index]?.task.instruction).toContain(instruction);
      const offer = await expectFrozenOffer(job.taskId);
      expect(offer).toMatchObject({ type: 'task.offer', payload: { agentRef, terminalProjection: selector } });
      // B2: the fresh offer has no `sessionRef` member -> its `session` is `{ mode: 'fresh' }` and names no `sessionRef`
      expect(offer.payload).toMatchObject({ session: { mode: 'fresh' } });
      expect(offer.payload.session).not.toHaveProperty('sessionRef');
      expect(offer.payload).not.toHaveProperty('messageEgress');
      const document: SummaryDocument = { schemaVersion: 'synthetic-host.summary.v1', jobId: job.jobId,
        coveredThroughTurnSeq: job.targetCoveredThrough, text };
      // The runtime submits the Summary through the route the SDK result helper uses.
      const token = adapter.startCalls[index]?.ctx.mcpServers?.byokagentresult?.env?.BYOK_AGENT_RESULT_CONTEXT;
      if (!token) throw new Error('synthetic Host: missing Agent result context');
      const connected = await connectControlClient({ storeDir, productId: options.productId });
      if (!connected.ok) throw new Error(connected.reason);
      try {
        expect(await connected.client.request('agent_results.submit', { contextToken: token, outcome: document }))
          .toMatchObject({ state: 'staged' });
      } finally { connected.client.close(); }
      adapter.sessions[index]!.emit({ type: 'progress', text: 'summary submitted' });
      adapter.sessions[index]!.emit({ type: 'turn_end' });
      const terminal = await settledTerminal(job.taskId, 'task.complete');
      expect(await sdk.tasks.agentMessage(job.taskId, deviceId, agentRef)).toBeUndefined();
      expect(accepted.map(item => item.taskId)).not.toContain(job.taskId);
      expect(adapter.sessions).toHaveLength(index + 1);
      return { terminal, document };
    };
    /** The Host reads the document only from the device terminal's `document`, never `summary` text. */
    const documentOf = (terminal: Awaited<ReturnType<typeof sdk.tasks.deviceTerminal>>): SummaryDocument => {
      if (terminal?.envelope.type !== 'task.complete' || terminal.envelope.payload.document === undefined) {
        throw new Error('synthetic Host: Summary terminal carries no result document');
      }
      return terminal.envelope.payload.document as SummaryDocument;
    };

    await runUserTurn('U1: answer in 中文 🐝', 'reply');
    await runUserTurn('U2: run the export', 'no-reply');
    await runUserTurn('U3: actually cancel the export', 'reply-then-fail');
    expect(host.transcript.map(turn => turn.outcome)).toEqual([
      { kind: 'reply', text: 'A1', executionTerminal: 'task.complete' },
      { kind: 'settled-without-reply', executionTerminal: 'task.fail',
        reason: 'runtime produced no reply text for the required Agent message', retryable: false },
      { kind: 'reply', text: 'A3', executionTerminal: 'task.fail' },
    ]);

    // (a) Summary result response loss: the first readback is dropped and
    // the Host re-reads the same terminal; nothing starts a second execution.
    const job1 = host.createJob('j1', 3);
    const startsBeforeJob1 = adapter.startCalls.length;
    const run1 = await runSummary(job1, 'S1: 中文 🐝; export U2 settled without reply; U3 cancelled it.');
    const reread = await sdk.tasks.deviceTerminal(job1.taskId);
    expect(reread).toEqual(run1.terminal);
    expect(documentOf(reread)).toEqual(run1.document);
    expect(adapter.startCalls.length - startsBeforeJob1).toBe(1);
    expect(host.apply(job1, documentOf(reread))).toBe('applied');
    // (b) Duplicate terminal delivery applies once: the version moved by exactly 1.
    expect(host.apply(job1, documentOf(await sdk.tasks.deviceTerminal(job1.taskId)))).toBe('replayed');
    expect(host.summary).toEqual({ version: 1, coveredThroughTurnSeq: 3, text: run1.document.text });

    const pack4 = await runUserTurn('U4: what did I ask about the export?', 'reply');
    expect(pack4.summary.version).toBe(1);
    expect(pack4.recentHistory).toEqual([]);
    const pack5 = await runUserTurn('U5: and in which language?', 'reply');
    expect(pack5.recentHistory.map(turn => turn.seq)).toEqual([4]);
    // The no-reply turn is carried only as outcome metadata, never as a pending command.
    for (const pack of [pack4, pack5]) expect(pack.input).not.toBe('U2: run the export');

    // (c) Two jobs on the same base run sequentially on the same home; the
    // later-covering one is applied first and the earlier one is rejected.
    const job2 = host.createJob('j2', 4);
    const job3 = host.createJob('j3', 5);
    expect([job2.baseVersion, job3.baseVersion]).toEqual([1, 1]);
    const run2 = await runSummary(job2, 'S2: through turn 4.');
    const run3 = await runSummary(job3, 'S3: through turn 5.');
    expect(host.apply(job3, documentOf(run3.terminal))).toBe('applied');
    expect(host.apply(job2, documentOf(run2.terminal))).toBe('stale');
    expect(host.summary).toEqual({ version: 2, coveredThroughTurnSeq: 5, text: 'S3: through turn 5.' });
    // Each CAS half is rejected on its own (hand-built jobs; no execution needed).
    const current = { ...host.summary };
    const handBuilt = (jobId: string, baseVersion: number, targetCoveredThrough: number): [SummaryJob, SummaryDocument] => [
      { jobId, baseVersion, baseCoveredThrough: 0, targetCoveredThrough, taskId: `summary-${jobId}` },
      { schemaVersion: 'synthetic-host.summary.v1', jobId, coveredThroughTurnSeq: targetCoveredThrough, text: `hand-built ${jobId}` },
    ];
    // Stale base only: the target (6) would extend coverage (5), but the job froze against v1 while the Summary is v2.
    expect(host.apply(...handBuilt('j-stale-base', 1, 6))).toBe('stale');
    expect(host.summary).toEqual(current);
    // Mirror: the base is current (v2), but the target (5) does not extend coverage (5).
    expect(host.apply(...handBuilt('j-no-extend', 2, 5))).toBe('stale');
    expect(host.summary).toEqual(current);

    const pack6 = await runUserTurn('U6: summarize where we are', 'reply');
    expect(pack6.summary).toEqual({ version: 2, coveredThroughTurnSeq: 5, text: 'S3: through turn 5.' });
    expect(pack6.recentHistory).toEqual([]);

    // An accepted reply survives a later Host cancel: it is settled as a reply and
    // is carried in the next ContextPack's recent history, never as a pending command.
    await runUserTurn('U7: draft the follow-up email', 'reply-then-cancel');
    expect(host.transcript.at(-1)?.outcome).toEqual({ kind: 'reply', text: 'A7', executionTerminal: 'task.cancelled' });
    const pack8 = await runUserTurn('U8: send what you drafted', 'reply');
    expect(pack8.summary.coveredThroughTurnSeq).toBe(5);
    expect(pack8.recentHistory.map(turn => [turn.seq, turn.outcome])).toEqual([
      [6, { kind: 'reply', text: 'A6', executionTerminal: 'task.complete' }],
      [7, { kind: 'reply', text: 'A7', executionTerminal: 'task.cancelled' }],
    ]);

    // Same-home single writer: every execution ran in one workspace, each a fresh session.
    expect(new Set(adapter.startCalls.map(call => call.ctx.workspaceDir)).size).toBe(1);
    expect(new Set(adapter.sessions.map(session => session.sessionRef)).size).toBe(adapter.sessions.length);
    expect(adapter.startCalls).toHaveLength(host.transcript.length + summaryTaskIds.length);
    expect(adapter.startCalls.filter(call => call.ctx.mcpServers?.byokagentresult !== undefined)).toHaveLength(summaryTaskIds.length);
    expect(accepted.map(item => item.taskId)).toEqual(['user-turn-1', 'user-turn-3', 'user-turn-4', 'user-turn-5', 'user-turn-6', 'user-turn-7', 'user-turn-8']);

    // (d) Restart on the same SQLite file: offers, terminals and frozen bytes read back identically.
    const taskIds = [...host.frozen.keys()];
    const before = new Map<string, unknown>();
    for (const taskId of taskIds) {
      before.set(taskId, { offer: await sdk.tasks.offer(taskId), terminal: await sdk.tasks.deviceTerminal(taskId) });
    }
    const replyMessage = await sdk.tasks.agentMessage('user-turn-3', deviceId, agentRef);
    const cancelledReply = await sdk.tasks.agentMessage('user-turn-7', deviceId, agentRef);
    await daemon.stop(); daemonStopped = true;
    await stopServer(http.server); httpStopped = true;
    await sdk.close();
    sdk = createByokServer(options);
    for (const taskId of taskIds) {
      expect({ offer: await sdk.tasks.offer(taskId), terminal: await sdk.tasks.deviceTerminal(taskId) }).toEqual(before.get(taskId));
      await expectFrozenOffer(taskId);
    }
    for (const taskId of summaryTaskIds) expect(await sdk.tasks.agentMessage(taskId, deviceId, agentRef)).toBeUndefined();
    expect(await sdk.tasks.agentMessage('user-turn-3', deviceId, agentRef)).toEqual(replyMessage);
    expect(await sdk.tasks.agentMessage('user-turn-7', deviceId, agentRef)).toEqual(cancelledReply);
    expect(cancelledReply).toMatchObject({ payload: { body: 'A7' }, disposition: { outcome: 'accepted' } });
    expect(await sdk.tasks.agentMessage('user-turn-2', deviceId, agentRef)).toBeUndefined();
  } finally {
    if (!daemonStopped) await daemon.stop();
    if (!httpStopped) await stopServer(http.server);
    await sdk.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 60000);
