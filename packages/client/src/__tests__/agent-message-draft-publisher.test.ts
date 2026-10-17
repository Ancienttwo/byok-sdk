import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_MESSAGE_DRAFT_FRAME_MAX_BYTES, type AgentEvent, type Envelope } from '@byok-sdk/protocol';
import { AgentMessageDraftPublisher } from '../daemon/agent-message-draft';
import { toRuntimeInfoCapabilities } from '../daemon/runtime-capabilities';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { CodexAdapter } from '../adapters/codex/codex-adapter';

const agentRef = { agentId: 'draft-agent', profileRevision: '1' };
const frameMax = AGENT_MESSAGE_DRAFT_FRAME_MAX_BYTES;
type Draft = Extract<Envelope, { type: 'agent.message.draft' }>;

function fixture(options: { maxBytes?: number; wholeMessages?: boolean; capabilities?: string[] } = {}) {
  const sent: Draft[] = [];
  let capabilities = options.capabilities ?? ['agent-message-draft'];
  const publisher = new AgentMessageDraftPublisher({
    taskId: 'draft-task', agentRef, maxBytes: options.maxBytes ?? 256 * 1024,
    maxCoalesceMs: 250, progressEventsAreMessages: options.wholeMessages ?? false,
    getServerCapabilities: () => capabilities,
    send: envelope => {
      expect(envelope.type).toBe('agent.message.draft');
      if (envelope.type === 'agent.message.draft') sent.push(envelope);
    },
  });
  return { publisher, sent, push: (text: string) => publisher.push({ type: 'progress', text }),
    withdraw: () => { capabilities = []; } };
}

afterEach(() => vi.useRealTimers());

describe('AgentMessageDraftPublisher', () => {
  it('coalesces from the first pending event and uses byte offsets without seq', () => {
    vi.useFakeTimers();
    const { push, sent, publisher } = fixture();
    push('你');
    vi.advanceTimersByTime(249);
    push('好');
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent.map(e => e.payload)).toEqual([{ agentRef, revision: 1, offset: 0, text: '你好' }]);
    push('!');
    publisher.flush();
    expect(sent[1]?.payload).toEqual({ agentRef, revision: 1, offset: 6, text: '!' });
    for (const frame of sent) {
      expect(frame.task_id).toBe('draft-task');
      expect(frame).not.toHaveProperty('seq');
    }
    vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(2);
  });

  it.each(['a', '你', '🙂'])('splits %s at the frame cap on UTF-8 boundaries', char => {
    const { push, sent, publisher } = fixture();
    const text = 'a'.repeat(frameMax - 1) + char.repeat(frameMax);
    push(text);
    expect(sent.length).toBeGreaterThan(0);
    publisher.flush();
    expect(sent.map(e => e.payload.text).join('')).toBe(text);
    let offset = 0;
    for (const frame of sent) {
      expect(frame.payload.offset).toBe(offset);
      expect(frame.payload.text).not.toContain('\ufffd');
      const bytes = Buffer.byteLength(frame.payload.text);
      expect(bytes).toBeGreaterThan(0);
      expect(bytes).toBeLessThanOrEqual(frameMax);
      offset += bytes;
    }
    expect(offset).toBe(Buffer.byteLength(text));
  });

  it('holds a split surrogate pair across a timer flush', () => {
    vi.useFakeTimers();
    const { push, sent, publisher } = fixture();
    push('hi\ud83d');
    vi.advanceTimersByTime(250);
    expect(sent.map(e => e.payload.text)).toEqual(['hi']);
    push('\ude42!');
    publisher.flush();
    expect(sent.map(e => e.payload.text).join('')).toBe('hi🙂!');
    expect(sent[1]?.payload.offset).toBe(2);
  });

  it.each([1, 3, 4, frameMax - 1, frameMax, frameMax + 1])('marks overflow once at a %i byte budget', maxBytes => {
    vi.useFakeTimers();
    const { push, sent, publisher } = fixture({ maxBytes });
    const text = '🙂'.repeat(frameMax);
    push(text);
    push('ignored');
    publisher.flush();
    vi.advanceTimersByTime(1000);
    expect(sent.filter(e => e.payload.overflow)).toHaveLength(1);
    expect(sent.at(-1)?.payload.overflow).toBe(true);
    const accepted = sent.map(e => e.payload.text).join('');
    expect(accepted).toBe('🙂'.repeat(Math.floor(maxBytes / 4)));
    expect(Buffer.byteLength(accepted)).toBeLessThanOrEqual(maxBytes);
    expect(sent.every(e => Buffer.byteLength(e.payload.text) <= frameMax)).toBe(true);
  });

  it('marks a later overflow with one empty frame when the byte budget was already sent', () => {
    const { push, sent, publisher } = fixture({ maxBytes: 4 });
    push('🙂');
    publisher.flush();
    expect(sent[0]?.payload.overflow).toBeUndefined();
    push('x');
    push('y');
    publisher.flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.payload).toEqual({ agentRef, revision: 1, offset: 4, text: '', overflow: true });
  });

  it('replaces non-blank whole messages, preserves blank suffixes, and resumes after overflow', () => {
    const { push, sent, publisher } = fixture({ maxBytes: 6, wholeMessages: true });
    push('first-too-long');
    expect(sent[0]?.payload).toEqual({ agentRef, revision: 2, offset: 0, text: 'first-', overflow: true });
    push('next');
    push(' \n');
    publisher.flush();
    expect(sent[1]?.payload).toEqual({ agentRef, revision: 3, offset: 0, text: 'next \n' });
    push('last');
    publisher.flush();
    expect(sent[2]?.payload).toEqual({ agentRef, revision: 4, offset: 0, text: 'last' });
  });

  it.each<AgentEvent>([
    { type: 'tool_use', tool: 'read', input: {} },
    { type: 'tool_result', tool: 'read', output: 'done' },
    { type: 'needs_approval', summary: 'continue' },
  ])('resets the closing text on $type', event => {
    vi.useFakeTimers();
    const { push, sent, publisher } = fixture();
    push('narration');
    publisher.flush();
    push('unsent narration');
    publisher.push(event);
    vi.advanceTimersByTime(250);
    expect(sent[1]?.payload).toEqual({ agentRef, revision: 2, offset: 0, text: '' });
    push('answer');
    publisher.push({ type: 'usage', inputTokens: 1, outputTokens: 1 });
    publisher.push({ type: 'artifact', name: 'file.txt', contentType: 'text/plain' });
    publisher.flush();
    expect(sent[2]?.payload).toEqual({ agentRef, revision: 2, offset: 0, text: 'answer' });
  });

  it('drops an unsent revision and clears its timer', () => {
    vi.useFakeTimers();
    const { push, sent, publisher } = fixture({ wholeMessages: true });
    push('old');
    vi.advanceTimersByTime(200);
    push('new');
    vi.advanceTimersByTime(50);
    expect(sent).toEqual([]);
    publisher.flush();
    expect(sent.map(e => e.payload.text)).toEqual(['new']);
    expect(sent[0]?.payload.offset).toBe(0);
  });

  it('sends zero frames without the server capability', () => {
    vi.useFakeTimers();
    const { push, sent, publisher } = fixture({ capabilities: [] });
    push('x'.repeat(frameMax * 2));
    publisher.flush();
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([]);
  });

  it('drops pending text when the server withdraws the capability', () => {
    vi.useFakeTimers();
    const { push, sent, withdraw, publisher } = fixture();
    push('pending');
    withdraw();
    vi.advanceTimersByTime(250);
    publisher.flush();
    expect(sent).toEqual([]);
  });

  it('stops timers and ignores late progress after publish or cancellation', () => {
    vi.useFakeTimers();
    const { push, sent, publisher } = fixture();
    push('pending');
    publisher.stop();
    push('late');
    publisher.flush();
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('maps Pi opt-in and explicit false while leaving Claude and Codex unset', () => {
    expect(toRuntimeInfoCapabilities(new PiAdapter().descriptor.capabilities).messageDraft).toBe(true);
    expect(toRuntimeInfoCapabilities({ steer: false, resume: false, approvalInteractive: false, messageDraft: false }).messageDraft).toBe(false);
    const claude = new ClaudeAdapter();
    expect(claude.descriptor.progressEventsAreMessages).toBe(true);
    for (const adapter of [claude, new CodexAdapter()]) {
      expect(adapter.descriptor.capabilities).not.toHaveProperty('messageDraft');
      expect(toRuntimeInfoCapabilities(adapter.descriptor.capabilities)).not.toHaveProperty('messageDraft');
    }
  });
});
