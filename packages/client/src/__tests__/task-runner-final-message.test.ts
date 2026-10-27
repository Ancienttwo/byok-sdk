import { FRESH_OFFER, freshOfferRunnerDeps } from './fixtures/fresh-offer';
import { freshTestAgentRef, testAgentHomeDeps } from './fixtures/test-agent';
import { testScratchOwner } from "./fixtures/execution-scratch";
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@byok-sdk/protocol';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import { ApprovalRegistry } from '../daemon/approvals';
import type { BlobResolver } from '../daemon/blob-client';
import { prependAgentMemoryGuidance } from '../daemon/memory-guidance';
import { TaskRunner, type TaskRunnerDeps } from '../daemon/task-runner';
import { freezeRuntimeAdapterDescriptor, type RuntimeAdapter } from '../types';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { testIngressBudget } from './fixtures/activity-ingress';

const unusedBlobClient: BlobResolver = {
  resolveInstruction: async () => {
    throw new Error('not used in this test');
  },
  uploadArtifact: async () => {
    throw new Error('not used in this test');
  },
};

/** A stub whose descriptor declares whole-message `progress` events, as the Codex adapter does. */
function wholeMessageAdapter(): StubRuntimeAdapter {
  const adapter = new StubRuntimeAdapter('codex');
  Object.defineProperty(adapter, 'descriptor', {
    value: freezeRuntimeAdapterDescriptor({ ...adapter.descriptor, progressEventsAreMessages: true }),
  });
  return adapter;
}

const INSTRUCTION = 'reply with exactly: CONSOLIDATED';

const CLAUDE_FIXTURE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));

async function makeRunner(
  adapter: RuntimeAdapter,
  sent: Envelope[],
  extra: Partial<TaskRunnerDeps> = {},
): Promise<TaskRunner> {
  return new TaskRunner({ getIngressBudget: testIngressBudget, scratchRoot: testScratchOwner(), ...freshOfferRunnerDeps(),
    adapters: [adapter],
    ...testAgentHomeDeps(),
    deviceId: 'device-final-message',
    send: (envelope) => sent.push(envelope),
    blobClient: unusedBlobClient,
    approvalRegistry: new ApprovalRegistry(),
    storeDir: 'unused-store-dir',
    productId: 'unused-product-id',
    ...extra,
  });
}

async function startTask(runner: TaskRunner, taskId: string, runtime: 'pi' | 'claude' | 'codex'): Promise<void> {
  await runner.handleEnvelope(
    createEnvelope('task.offer', { agentRef: freshTestAgentRef(),  instruction: INSTRUCTION, runtime, ...FRESH_OFFER }, { taskId, seq: 1 }),
  );
}

async function completion(sent: Envelope[], taskId: string) {
  await vi.waitFor(() => expect(sent.some((item) => item.type === 'task.complete' && item.task_id === taskId)).toBe(true));
  const envelope = sent.find((item) => item.type === 'task.complete' && item.task_id === taskId);
  if (envelope?.type !== 'task.complete') throw new Error(`missing task.complete for ${taskId}`);
  return envelope.payload;
}

describe('TaskRunner task.complete.finalMessage (#322)', () => {
  it('the bundled Codex adapter declares whole-message progress events', () => {
    expect(new CodexAdapter().descriptor.progressEventsAreMessages).toBe(true);
  });

  it('publishes a Claude closing reply once when a later model call repeats it (#501)', async () => {
    vi.stubEnv('FAKE_CLAUDE_REPEAT_CLOSING_TEXT', '1');
    try {
      const adapter = new ClaudeAdapter({ resolveBin: () => ({ command: CLAUDE_FIXTURE, source: 'path' }) });
      const sent: Envelope[] = [];
      const runner = await makeRunner(adapter, sent);
      await startTask(runner, 'claude-repeated-reply', 'claude');

      const payload = await completion(sent, 'claude-repeated-reply');
      expect(payload.finalMessage).toMatch(/^reply-1:/);
      // The whole run's text still records both model calls.
      expect(payload.summary).toBe(payload.finalMessage!.repeat(2));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps every text block of one Claude message in the closing reply', async () => {
    vi.stubEnv('FAKE_CLAUDE_SPLIT_CLOSING_TEXT', '1');
    try {
      const adapter = new ClaudeAdapter({ resolveBin: () => ({ command: CLAUDE_FIXTURE, source: 'path' }) });
      const sent: Envelope[] = [];
      const runner = await makeRunner(adapter, sent);
      await startTask(runner, 'claude-split-reply', 'claude');

      const payload = await completion(sent, 'claude-split-reply');
      expect(payload.finalMessage).toBe(`reply-1:${prependAgentMemoryGuidance(INSTRUCTION)}`);
      expect(payload.summary).toBe(payload.finalMessage);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ['FAKE_CLAUDE_REPEAT_CLOSING_TEXT', 2],
    ['FAKE_CLAUDE_SPLIT_CLOSING_TEXT', 1],
  ] as const)('keeps the Claude closing reply of %s with partial messages on (#501, #870)', async (toggle, copies) => {
    vi.stubEnv(toggle, '1');
    vi.stubEnv('FAKE_CLAUDE_PARTIAL_MESSAGES', '1');
    try {
      const adapter = new ClaudeAdapter({ resolveBin: () => ({ command: CLAUDE_FIXTURE, source: 'path' }) });
      const sent: Envelope[] = [];
      const runner = await makeRunner(adapter, sent);
      await startTask(runner, `claude-partial-${copies}`, 'claude');

      const payload = await completion(sent, `claude-partial-${copies}`);
      expect(payload.finalMessage).toBe(`reply-1:${prependAgentMemoryGuidance(INSTRUCTION)}`);
      expect(payload.summary).toBe(payload.finalMessage!.repeat(copies));
      expect(JSON.stringify(sent)).not.toContain('message_draft_delta');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('separates the last whole message from commentary that came before it without a tool call', async () => {
    const adapter = wholeMessageAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);
    await startTask(runner, 'codex-commentary', 'codex');
    const session = adapter.sessions[0]!;

    session.emit({ type: 'progress', text: 'I will consolidate memory.' });
    session.emit({ type: 'progress', text: 'CONSOLIDATED' });
    session.emit({ type: 'progress', text: '\n' });
    session.emit({ type: 'usage', inputTokens: 10, outputTokens: 2 });
    session.emit({ type: 'turn_end' });

    const payload = await completion(sent, 'codex-commentary');
    expect(payload.summary).toBe('I will consolidate memory.CONSOLIDATED\n');
    // A trailing blank message does not erase the answer before it.
    expect(payload.finalMessage).toBe('CONSOLIDATED\n');
  });

  it('joins streaming deltas after the last tool interaction for a delta adapter', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);
    await startTask(runner, 'pi-deltas', 'pi');
    const session = adapter.sessions[0]!;

    session.emit({ type: 'progress', text: 'Let me read MEMORY.md first.' });
    session.emit({ type: 'tool_use', tool: 'read', input: { path: 'MEMORY.md' }, toolCallId: 'call-1' });
    session.emit({ type: 'tool_result', tool: 'read', output: 'notes', toolCallId: 'call-1' });
    session.emit({ type: 'progress', text: 'CONSOLI' });
    session.emit({ type: 'progress', text: 'DATED' });
    session.emit({ type: 'usage', inputTokens: 10, outputTokens: 2 });
    session.emit({ type: 'turn_end' });

    const payload = await completion(sent, 'pi-deltas');
    expect(payload.summary).toBe('Let me read MEMORY.md first.CONSOLIDATED');
    expect(payload.finalMessage).toBe('CONSOLIDATED');
  });

  it('omits finalMessage when the run ends on a tool interaction with no closing text', async () => {
    const adapter = wholeMessageAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);
    await startTask(runner, 'ends-on-tool', 'codex');
    const session = adapter.sessions[0]!;

    session.emit({ type: 'progress', text: 'Writing the note.' });
    session.emit({ type: 'tool_use', tool: 'file_change', input: {}, toolCallId: 'call-1' });
    session.emit({ type: 'tool_result', tool: 'file_change', output: {}, toolCallId: 'call-1' });
    session.emit({ type: 'turn_end' });

    const payload = await completion(sent, 'ends-on-tool');
    expect(payload.summary).toBe('Writing the note.');
    expect(Object.hasOwn(payload, 'finalMessage')).toBe(false);
  });

  it('omits finalMessage when every whole message is blank', async () => {
    const adapter = wholeMessageAdapter();
    const sent: Envelope[] = [];
    const runner = await makeRunner(adapter, sent);
    await startTask(runner, 'all-blank', 'codex');
    const session = adapter.sessions[0]!;

    session.emit({ type: 'progress', text: ' ' });
    session.emit({ type: 'progress', text: '\n' });
    session.emit({ type: 'turn_end' });

    const payload = await completion(sent, 'all-blank');
    expect(payload.summary).toBe(' \n');
    expect(Object.hasOwn(payload, 'finalMessage')).toBe(false);
  });
});
