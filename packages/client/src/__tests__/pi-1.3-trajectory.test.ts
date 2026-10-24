import { createHash } from 'node:crypto';
import { promises as fs, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAgentLoop, type AgentEvent as PiEvent, type AgentTool, type StreamFn, type ToolExecutionMode } from '@earendil-works/pi-agent-core';
import { createAssistantMessageEventStream, Type, type AssistantMessage, type Message, type Model } from '@earendil-works/pi-ai';
import type { AgentEvent } from '@byok-sdk/protocol';
import { mapPiMessageToAgentEvent } from '../adapters/pi/events';
import { OFFICIAL_PI_PROVENANCE } from '../adapters/pi/official-pi-installation.mjs';
import { PiRpcClient, type PiRpcMessage } from '../adapters/pi/rpc-client';
import { RuntimeExecutionFailure } from '../runtime-failure';

const clients: PiRpcClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.dispose()));
  vi.unstubAllGlobals();
});

const model: Model<'openai-completions'> = {
  id: 'synthetic-only', name: 'synthetic-only', api: 'openai-completions', provider: 'synthetic-only',
  baseUrl: 'http://127.0.0.1:9', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 64,
};
const call = { type: 'toolCall', id: 'call-one', name: 'observe', arguments: {} } as const;
function message(content: AssistantMessage['content'], stopReason: AssistantMessage['stopReason']): AssistantMessage {
  return { role: 'assistant', content, stopReason, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: 0, ...(stopReason === 'aborted' ? { errorMessage: 'synthetic abort' } : {}),
  };
}
function response(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    if (message.stopReason === 'aborted') stream.push({ type: 'error', reason: 'aborted', error: message });
    else stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
    stream.end(message);
  });
  return stream;
}

async function coreRecord(scenario: 'normal' | 'tool-error' | 'abort-tool' | 'abort-success' | 'abort-stream', toolExecution: ToolExecutionMode, queued = false) {
  const fetch = vi.fn(() => { throw new Error('T0 forbids network requests'); });
  vi.stubGlobal('fetch', fetch);
  const controller = new AbortController();
  let providerFrames = 0;
  const stream: StreamFn = (_model, _context, options) => {
    providerFrames++;
    if (scenario === 'abort-stream' || options?.signal?.aborted) {
      controller.abort();
      return response(message([], 'aborted'));
    }
    const calls = queued ? [call, { ...call, id: 'call-two' }] : [call];
    return response(providerFrames === 1 ? message(calls, 'toolUse') : message([{ type: 'text', text: 'synthetic final' }], 'stop'));
  };
  const execute = vi.fn<AgentTool['execute']>(async (_id, _args, signal) => {
    if (scenario === 'tool-error') throw new Error('synthetic tool failure');
    if (scenario === 'abort-success') controller.abort();
    if (scenario === 'abort-tool') {
      // Abort only after the real loop entered tool.execute. No sleeps or
      // default model stream participate in this experiment.
      const aborted = new Promise<never>((_resolve, reject) => {
        signal!.addEventListener('abort', () => reject(new Error('synthetic tool aborted')), { once: true });
      });
      controller.abort();
      return aborted;
    }
    return { content: [{ type: 'text', text: 'synthetic result' }], details: {} };
  });
  const events: PiEvent[] = [];
  await runAgentLoop([{ role: 'user', content: 'synthetic prompt', timestamp: 0 }], {
    messages: [], tools: [{ name: 'observe', label: 'observe', description: 'synthetic observation', parameters: Type.Object({}), execute }],
  }, { model, toolExecution, convertToLlm: messages => messages.filter((entry): entry is Message =>
    entry.role === 'system' || entry.role === 'user' || entry.role === 'assistant' || entry.role === 'toolResult') },
  event => { events.push(event); }, controller.signal, stream);
  expect(fetch).not.toHaveBeenCalled();
  return { events, execute, providerFrames };
}

describe('Octop T0: fixed Pi 1.4.0 emitter with synthetic model responses', () => {
  it('binds the research to the reviewed closure and installed emitter bytes', () => {
    expect(OFFICIAL_PI_PROVENANCE).toMatchObject({ packageVersion: '1.4.0',
      upstreamCommit: '4a080252f06caf63a525d7873c5d94d3c23887e0',
      closureDigest: '79c414be071768df15f0a107595564b11c67d904c601e7b2ccf1495fc3053fcc' });
    const root = new URL('../../node_modules/@earendil-works/pi-agent-core/', import.meta.url);
    expect(JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).version).toBe('1.4.0');
    expect(createHash('sha256').update(readFileSync(new URL('dist/agent-loop.js', root))).digest('hex'))
      .toBe('22ee81f9977e211044c1ad41a763876c793ca7fc1c5b39b9fa7f76f3cb281129');
  });

  it.each(['sequential', 'parallel'] as const)('pairs successful tools in %s mode and retains the later final response', async mode => {
    const { events, execute, providerFrames } = await coreRecord('normal', mode);
    expect(events.filter(event => event.type === 'tool_execution_start')).toEqual([
      { type: 'tool_execution_start', toolCallId: 'call-one', toolName: 'observe', args: {} },
    ]);
    expect(events.filter(event => event.type === 'tool_execution_end')).toEqual([
      expect.objectContaining({ toolCallId: 'call-one', toolName: 'observe', isError: false }),
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(providerFrames).toBe(2);
    expect(events.filter(event => event.type === 'turn_end')).toHaveLength(2);
    expect(events.at(-1)?.type).toBe('agent_end');
  });

  it.each(['sequential', 'parallel'] as const)('pairs a thrown tool error in %s mode instead of losing its result', async mode => {
    const { events, execute } = await coreRecord('tool-error', mode);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(events.filter(event => event.type === 'tool_execution_start')).toHaveLength(1);
    expect(events.filter(event => event.type === 'tool_execution_end')).toEqual([
      expect.objectContaining({ toolCallId: 'call-one', isError: true,
        result: { content: [{ type: 'text', text: 'synthetic tool failure' }], details: {} } }),
    ]);
    expect(events.at(-1)?.type).toBe('agent_end');
  });

  it.each(['sequential', 'parallel'] as const)('pairs a cooperative abort during tool execution in %s mode', async mode => {
    const { events, execute } = await coreRecord('abort-tool', mode);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(events.filter(event => event.type === 'tool_execution_start')).toHaveLength(1);
    expect(events.filter(event => event.type === 'tool_execution_end')).toEqual([
      expect.objectContaining({ toolCallId: 'call-one', isError: true }),
    ]);
    expect(events.filter(event => event.type === 'turn_end').length).toBeGreaterThan(0);
    expect(events.at(-1)?.type).toBe('agent_end');
  });

  it('emits no tool start or end when the synthetic model stream aborts before tool execution', async () => {
    const { events, execute, providerFrames } = await coreRecord('abort-stream', 'parallel');
    expect(execute).not.toHaveBeenCalled();
    expect(providerFrames).toBe(1);
    expect(events.filter(event => event.type.startsWith('tool_execution_'))).toEqual([]);
    expect(events.filter(event => event.type === 'turn_end')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('agent_end');
  });

  it('pairs a queued parallel call with an abort result without executing it', async () => {
    const { events, execute } = await coreRecord('abort-tool', 'parallel', true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(events.filter(event => event.type === 'tool_execution_start').map(event => event.toolCallId)).toEqual(['call-one', 'call-two']);
    expect(events.filter(event => event.type === 'tool_execution_end')).toEqual([
      expect.objectContaining({ toolCallId: 'call-two', isError: true,
        result: { content: [{ type: 'text', text: 'Operation aborted' }], details: {} } }),
      expect.objectContaining({ toolCallId: 'call-one', isError: true }),
    ]);
  });

  it('does not change a successful tool result into an error merely because abort was requested', async () => {
    const { events } = await coreRecord('abort-success', 'parallel');
    expect(events.filter(event => event.type === 'tool_execution_end')).toEqual([
      expect.objectContaining({ toolCallId: 'call-one', isError: false }),
    ]);
    expect(events.at(-1)?.type).toBe('agent_end');
  });
});

const records = new URL('./fixtures/pi-1.3-trajectory/', import.meta.url);
describe('Octop T0: synthetic RPC records through the real SDK parser and mapper', () => {
  it.each(['normal', 'tool-error', 'interrupted', 'killed'] as const)('replays %s without a Pi process or provider', async scenario => {
    const record = new URL(`${scenario}.jsonl`, records);
    const frames: PiRpcMessage[] = [];
    const client = new PiRpcClient({ command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/pi-trajectory-replay.mjs', import.meta.url)), fileURLToPath(record), scenario],
      cwd: import.meta.dirname, env: {}, onFrame: frame => { frames.push(frame); },
    });
    clients.push(client);
    expect(await client.send({ type: 'replay_synthetic' })).toMatchObject({ success: true });
    const raw: PiRpcMessage[] = [];
    for await (const frame of client.events) raw.push(frame);
    await client.waitClosed();
    const lines = (await fs.readFile(record, 'utf8')).split('\n');
    if (scenario === 'killed') {
      expect(lines.at(-1)).toBe('{"type":"tool_execution_end"');
      lines.pop();
      expect(client.terminalError?.message).toContain('signal=SIGKILL');
    }
    const completeFrames = lines.filter(Boolean).map(line => JSON.parse(line));
    expect(raw).toEqual(completeFrames);
    expect(frames.filter(frame => frame.type !== 'response')).toEqual(raw);
    const mapped: AgentEvent[] = [];
    let failure: unknown;
    for (const frame of raw) {
      try { const event = mapPiMessageToAgentEvent(frame); if (event) mapped.push(event); }
      catch (error) { failure = error; }
    }
    expect(mapped.filter(event => event.type === 'tool_use')).toEqual([
      { type: 'tool_use', tool: 'observe', toolCallId: 'call-one', input: {} },
    ]);
    expect(mapped.filter(event => event.type === 'tool_result')).toEqual(scenario === 'killed' ? [] : [
      expect.objectContaining({ toolCallId: 'call-one', isError: scenario !== 'normal' }),
    ]);
    expect(mapped.filter(event => event.type === 'turn_end')).toHaveLength(scenario === 'normal' || scenario === 'tool-error' ? 1 : 0);
    if (scenario === 'interrupted') {
      expect(failure).toBeInstanceOf(RuntimeExecutionFailure);
      expect(failure).toMatchObject({ category: 'semantic', retry: 'non-retryable' });
    } else expect(failure).toBeUndefined();
    expect(raw.filter(frame => frame.type === 'agent_settled')).toHaveLength(scenario === 'killed' ? 0 : 1);
  });
});
