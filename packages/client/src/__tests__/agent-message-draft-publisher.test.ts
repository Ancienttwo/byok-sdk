import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AGENT_MESSAGE_DRAFT_FRAME_MAX_BYTES, createEnvelope, type AgentEvent, type Envelope } from '@byok-sdk/protocol';
import { AgentMessageDraftPublisher } from '../daemon/agent-message-draft';
import { toRuntimeInfoCapabilities } from '../daemon/runtime-capabilities';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import { AgentHomeManager } from '../agent-home';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';
import { AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { ApprovalRegistry } from '../daemon/approvals';
import { TaskRunner } from '../daemon/task-runner';
import { freezeRuntimeAdapterDescriptor } from '../types';
import { testIngressBudget } from './fixtures/activity-ingress';
import { testScratchOwner } from './fixtures/execution-scratch';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { advertiseEveryDeviceFlag } from './support/advertised-capabilities';

const agentRef = { agentId: 'draft-agent', profileRevision: '1' };
const frameMax = AGENT_MESSAGE_DRAFT_FRAME_MAX_BYTES;
type Draft = Extract<Envelope, { type: 'agent.message.draft' }>;

function fixture(options: { maxBytes?: number; capabilities?: string[] } = {}) {
  const sent: Draft[] = [];
  let capabilities = options.capabilities ?? ['agent-message-draft'];
  const publisher = new AgentMessageDraftPublisher({
    taskId: 'draft-task', agentRef, maxBytes: options.maxBytes ?? 256 * 1024,
    maxCoalesceMs: 250,
    getServerCapabilities: () => capabilities,
    send: envelope => {
      expect(envelope.type).toBe('agent.message.draft');
      if (envelope.type === 'agent.message.draft') sent.push(envelope);
    },
  });
  return { publisher, sent, push: (text: string, startsMessage = false) => publisher.push({ type: 'progress', text }, startsMessage),
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
    const { push, sent, publisher } = fixture({ maxBytes: 6 });
    push('first-too-long', true);
    expect(sent[0]?.payload).toEqual({ agentRef, revision: 2, offset: 0, text: 'first-', overflow: true });
    push('next', true);
    push(' \n');
    publisher.flush();
    expect(sent[1]?.payload).toEqual({ agentRef, revision: 3, offset: 0, text: 'next \n' });
    push('last', true);
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
    const { push, sent, publisher } = fixture();
    push('old', true);
    vi.advanceTimersByTime(200);
    push('new', true);
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

  it('maps Pi opt-in and explicit false, and maps the Claude and Codex opt-in', () => {
    expect(toRuntimeInfoCapabilities(new PiAdapter().descriptor.capabilities).messageDraft).toBe(true);
    expect(toRuntimeInfoCapabilities({ steer: false, resume: false, approvalInteractive: false, messageDraft: false }).messageDraft).toBe(false);
    const claude = new ClaudeAdapter();
    expect(claude.descriptor.progressEventsAreMessages).toBe(true);
    for (const adapter of [claude, new CodexAdapter()]) {
      expect(adapter.descriptor.capabilities.messageDraft).toBe(true);
      expect(toRuntimeInfoCapabilities(adapter.descriptor.capabilities).messageDraft).toBe(true);
    }
  });
});

describe('AgentMessageDraftPublisher draft deltas', () => {
  const payloads = (sent: Draft[]) => sent.map(({ payload: { revision, offset, text } }) => ({ revision, offset, text }));

  it('adds no frame or revision when the progress event matches its deltas', () => {
    const { publisher, sent, push } = fixture();
    publisher.pushDelta('Hello ', true);
    publisher.pushDelta('world', false);
    publisher.flush();
    push('Hello world', true);
    publisher.flush();
    expect(payloads(sent)).toEqual([{ revision: 2, offset: 0, text: 'Hello world' }]);
  });

  it('appends the rest when the progress event extends its deltas', () => {
    const { publisher, sent, push } = fixture();
    publisher.pushDelta('Hel', true);
    publisher.flush();
    push('Hello', true);
    publisher.flush();
    expect(payloads(sent)).toEqual([{ revision: 2, offset: 0, text: 'Hel' }, { revision: 2, offset: 3, text: 'lo' }]);
  });

  it('opens a new revision with the progress text when it diverges from its deltas', () => {
    const { publisher, sent, push } = fixture();
    publisher.pushDelta('Helo', true);
    publisher.flush();
    push('Hello', true);
    publisher.flush();
    expect(payloads(sent)).toEqual([{ revision: 2, offset: 0, text: 'Helo' }, { revision: 3, offset: 0, text: 'Hello' }]);
  });

  it('resets once at a delta start and still resets at a later message without deltas', () => {
    const { publisher, sent, push } = fixture();
    for (const text of ['first', 'second']) {
      publisher.pushDelta(text, true);
      push(text, true);
      publisher.flush();
    }
    push('third', true);
    publisher.flush();
    expect(payloads(sent)).toEqual([
      { revision: 2, offset: 0, text: 'first' },
      { revision: 3, offset: 0, text: 'second' },
      { revision: 4, offset: 0, text: 'third' },
    ]);
  });

  it('reconciles each block of one message against the whole message', () => {
    const { publisher, sent, push } = fixture();
    publisher.pushDelta('Part ', true);
    publisher.pushDelta('one.', false);
    push('Part one.', true);
    publisher.pushDelta(' Part two.', false);
    push(' Part two.', false);
    publisher.flush();
    expect(payloads(sent)).toEqual([{ revision: 2, offset: 0, text: 'Part one. Part two.' }]);
  });

  it('keeps a blank message in the open revision', () => {
    const { publisher, sent, push } = fixture();
    publisher.pushDelta('first', true);
    push('first', true);
    publisher.pushDelta(' \n', false);
    push(' \n', false);
    publisher.flush();
    expect(payloads(sent)).toEqual([{ revision: 2, offset: 0, text: 'first \n' }]);
  });

  it('resets at a tool event and keeps unmarked deltas of the next run in one revision', () => {
    const { publisher, sent, push } = fixture();
    publisher.pushDelta('Let me look.', false);
    push('Let me look.');
    publisher.flush();
    publisher.push({ type: 'tool_use', tool: 'read', input: {} });
    publisher.pushDelta('Found ', false);
    publisher.pushDelta('it.', false);
    push('Found it.');
    publisher.flush();
    expect(payloads(sent)).toEqual([
      { revision: 1, offset: 0, text: 'Let me look.' },
      { revision: 2, offset: 0, text: 'Found it.' },
    ]);
  });

  it('adds no frame after overflow until the next reset', () => {
    const { publisher, sent, push } = fixture({ maxBytes: 4 });
    publisher.pushDelta('hello', true);
    push('hello', true);
    publisher.flush();
    expect(sent.map(e => e.payload)).toEqual([{ agentRef, revision: 2, offset: 0, text: 'hell', overflow: true }]);
  });

  it('ignores deltas without the server capability and after stop', () => {
    const quiet = fixture({ capabilities: [] });
    quiet.publisher.pushDelta('hidden', true);
    quiet.publisher.flush();
    expect(quiet.sent).toEqual([]);
    const { publisher, sent } = fixture();
    publisher.stop();
    publisher.pushDelta('late', true);
    publisher.flush();
    expect(sent).toEqual([]);
  });
});

describe('TaskRunner draft reconciliation before publish', () => {
  const runners: TaskRunner[] = [];
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(runners.splice(0).map(runner => runner.shutdownActiveTasks('test cleanup')));
    await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
  });

  async function start(wholeMessages = false) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-draft-finalize-'));
    roots.push(root);
    const storeDir = path.join(root, 'store');
    const sent: Envelope[] = [];
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available' }, {
      steer: true, resume: true, approvalInteractive: false, mcpToolsets: true, messageDraft: true,
    });
    if (wholeMessages) {
      Object.defineProperty(adapter, 'descriptor', {
        value: freezeRuntimeAdapterDescriptor({ ...adapter.descriptor, progressEventsAreMessages: true }),
      });
    }
    const policy = { ...DEFAULT_AGENT_EGRESS_POLICY,
      activity: { ...DEFAULT_AGENT_EGRESS_POLICY.activity, maxCoalesceMs: 10 } };
    const runner = new TaskRunner({
      getIngressBudget: testIngressBudget, scratchRoot: testScratchOwner(),
      adapters: [adapter],
      agentHome: new AgentHomeManager({ hostStorageRoot: path.join(root, 'home') }),
      agentEgressPolicy: policy, agentSessionHandoffs: new AgentSessionHandoffStore(),
      deviceId: 'draft-device', tenantId: 'draft-tenant', productId: 'draft-finalize', storeDir,
      getServerCapabilities: () => ['agent-message-draft'], send: envelope => { sent.push(envelope); },
      blobClient: { resolveInstruction: async () => '', uploadArtifact: async () => { throw new Error('unused'); } },
      approvalRegistry: new ApprovalRegistry(),
      agentMessageMcpBin: { command: process.execPath, args: ['/sdk/byok-agent-message-mcp.js'] },
      agentMessageMcpPreflight: async () => {},
      advertisedCapabilities: advertiseEveryDeviceFlag,
    });
    runners.push(runner);
    await runner.handleEnvelope(createEnvelope('task.offer', {
      instruction: 'reply', runtime: 'pi', agentRef, session: { mode: 'fresh' }, egressPolicy: policy,
      messageEgress: { mode: 'required', contract: 'draft.v1', contentType: 'text/plain', maxBytes: frameMax * 3 },
    }, { taskId: 'finalize-task', seq: 1 }));
    if (wholeMessages) expect(adapter.descriptor.progressEventsAreMessages).toBe(true);
    else expect(adapter.descriptor.progressEventsAreMessages).toBeUndefined();
    expect(adapter.sessions).toHaveLength(1);
    const frames = () => sent.filter((e): e is Draft => e.type === 'agent.message.draft');
    const published = async () => {
      await vi.waitFor(() => expect(sent.some(e => e.type === 'agent.message.publish')).toBe(true));
      const publish = sent.find(e => e.type === 'agent.message.publish');
      if (publish?.type !== 'agent.message.publish') throw new Error('missing publish');
      const lastRevision = frames().at(-1)?.payload.revision;
      const lastFrames = frames().filter(e => e.payload.revision === lastRevision);
      expect(lastFrames.length).toBeGreaterThan(0);
      expect(lastFrames.map(e => e.payload.text).join('')).toBe(publish.payload.body.toWellFormed());
      let offset = 0;
      for (const frame of lastFrames) {
        expect(frame.payload.offset).toBe(offset);
        expect(frame.payload.text.isWellFormed()).toBe(true);
        const size = Buffer.byteLength(frame.payload.text);
        expect(size).toBeLessThanOrEqual(frameMax);
        expect(frame.payload.overflow).toBeUndefined();
        offset += size;
      }
      expect(sent.indexOf(publish)).toBeGreaterThan(sent.findLastIndex(e => e.type === 'agent.message.draft'));
      return { publish, lastFrames };
    };
    return { runner, sent, session: adapter.sessions[0]!, frames, published,
      contextToken: adapter.startCalls[0]!.ctx.mcpServers!.byokagentmessage!.env!.BYOK_AGENT_MESSAGE_CONTEXT! };
  }

  it('replaces the empty post-tool revision with the whole-run fallback', async () => {
    const f = await start();
    f.session.emit({ type: 'progress', text: 'I will write the note.' });
    f.session.emit({ type: 'tool_use', tool: 'write', input: {} });
    f.session.emit({ type: 'tool_result', tool: 'write', output: 'done' });
    await vi.waitFor(() => expect(f.frames().at(-1)?.payload).toMatchObject({ revision: 3, text: '' }));
    f.session.emit({ type: 'turn_end' });
    const { publish, lastFrames } = await f.published();
    expect(publish.payload.body).toBe('I will write the note.');
    expect(lastFrames[0]?.payload.revision).toBe(4);
  });

  it('replaces runtime text with the tool-authored body across UTF-8 frame boundaries', async () => {
    const f = await start();
    f.session.emit({ type: 'progress', text: 'runtime narration' });
    await vi.waitFor(() => expect(f.frames()).toHaveLength(1));
    const body = 'a'.repeat(frameMax - 1) + '🙂'.repeat(100) + '\ud800';
    await f.runner.publishAgentMessage({ contextToken: f.contextToken, contentType: 'text/plain', body });
    const { publish, lastFrames } = await f.published();
    expect(publish.payload.body).toBe(body);
    expect(lastFrames).toHaveLength(2);
    expect(lastFrames[0]?.payload).toMatchObject({ revision: 2, offset: 0, text: 'a'.repeat(frameMax - 1) });
    expect(lastFrames[1]?.payload.offset).toBe(frameMax - 1);
  });

  it('sends no extra frame when the current draft already equals the body', async () => {
    const f = await start();
    f.session.emit({ type: 'progress', text: 'same reply' });
    await vi.waitFor(() => expect(f.frames()).toHaveLength(1));
    const before = f.frames();
    f.session.emit({ type: 'turn_end' });
    const { publish } = await f.published();
    expect(publish.payload.body).toBe('same reply');
    expect(f.frames()).toEqual(before);
  });

  it('projects a lone surrogate without changing the published body or adding a revision', async () => {
    const f = await start();
    f.session.emit({ type: 'progress', text: 'x\ud800' });
    f.session.emit({ type: 'turn_end' });
    const { publish, lastFrames } = await f.published();
    expect(publish.payload.body).toBe('x\ud800');
    expect(publish.payload.body.charCodeAt(1)).toBe(0xd800);
    expect(lastFrames.map(e => e.payload.text).join('')).toBe('x\ufffd');
    expect(new Set(f.frames().map(e => e.payload.revision))).toEqual(new Set([1]));
  });

  it('keeps three blocks of one message in one revision and calls the boundary hook once per block', async () => {
    const f = await start(true);
    const progressStartsMessage = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    Object.assign(f.session, { progressStartsMessage });
    const blocks = ['first ', 'second ', 'third'];
    for (const [index, text] of blocks.entries()) {
      const event = { type: 'progress' as const, text };
      f.session.emit(event);
      await vi.waitFor(() => expect(f.frames()).toHaveLength(index + 1));
      expect(progressStartsMessage).toHaveBeenCalledTimes(index + 1);
      expect(progressStartsMessage).toHaveBeenNthCalledWith(index + 1, event);
    }
    expect(f.frames().map(frame => frame.payload.revision)).toEqual([2, 2, 2]);
    const before = f.frames();
    f.session.emit({ type: 'turn_end' });
    const { publish } = await f.published();
    expect(publish.payload.body).toBe(blocks.join(''));
    expect(f.frames().map(frame => frame.payload.text).join('')).toBe(publish.payload.body);
    expect(f.frames()).toEqual(before);
    expect(f.frames()).toHaveLength(blocks.length);
    expect(progressStartsMessage).toHaveBeenCalledTimes(blocks.length);
  });

  it('starts a new revision only at the next message boundary', async () => {
    const f = await start(true);
    const progressStartsMessage = vi.fn()
      .mockReturnValueOnce(true).mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValueOnce(true);
    Object.assign(f.session, { progressStartsMessage });
    const blocks = ['first ', 'second ', 'third', 'next message'];
    for (const [index, text] of blocks.entries()) {
      f.session.emit({ type: 'progress', text });
      await vi.waitFor(() => expect(f.frames()).toHaveLength(index + 1));
    }
    expect(f.frames().map(frame => frame.payload.revision)).toEqual([2, 2, 2, 3]);
    expect(f.frames().at(-1)?.payload.offset).toBe(0);
    const before = f.frames();
    f.session.emit({ type: 'turn_end' });
    const { publish } = await f.published();
    expect(publish.payload.body).toBe('next message');
    expect(f.frames()).toEqual(before);
    expect(progressStartsMessage).toHaveBeenCalledTimes(blocks.length);
  });

  it('keeps per-event message boundaries without a session hook and preserves blank suffixes', async () => {
    const f = await start(true);
    expect(f.session).not.toHaveProperty('progressStartsMessage');
    const blocks = ['first', ' \n', 'second'];
    for (const [index, text] of blocks.entries()) {
      f.session.emit({ type: 'progress', text });
      await vi.waitFor(() => expect(f.frames()).toHaveLength(index + 1));
    }
    expect(f.frames().map(frame => frame.payload.revision)).toEqual([2, 2, 3]);
    expect(f.frames().map(frame => frame.payload.offset)).toEqual([0, 5, 0]);
    const before = f.frames();
    f.session.emit({ type: 'turn_end' });
    const { publish } = await f.published();
    expect(publish.payload.body).toBe('second');
    expect(f.frames()).toEqual(before);
  });

  it('routes draft deltas only to the draft lane', async () => {
    const f = await start(true);
    f.session.emit({ type: 'message_draft_delta', text: 'draft-only ', startsMessage: true });
    await vi.waitFor(() => expect(f.frames()).toHaveLength(1));
    f.session.emit({ type: 'progress', text: 'accepted reply' });
    f.session.emit({ type: 'turn_end' });
    const { publish, lastFrames } = await f.published();
    expect(publish.payload.body).toBe('accepted reply');
    expect(lastFrames[0]?.payload.revision).toBe(3);
    const wire = JSON.stringify(f.sent.filter(e => e.type !== 'agent.message.draft'));
    expect(wire).not.toContain('draft-only');
    expect(wire).not.toContain('message_draft_delta');
  });
});
