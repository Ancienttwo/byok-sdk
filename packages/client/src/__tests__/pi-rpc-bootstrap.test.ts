import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { resolvePiBin } from '../adapters/pi/resolve-bin';
import { PiRpcClient, type PiRpcMessage, type SpawnFn } from '../adapters/pi/rpc-client';
import { RuntimeExecutionFailure } from '../runtime-failure';
import type { Session } from '../types';
import { baseEnv, createSandbox } from './runtime-contract/contract';
import { startLoopbackProvider, type LoopbackProvider } from './runtime-contract/loopback';
import { startPreparedOperation } from './fixtures/prepared-operation';

// #2299: a user extension can start a Pi run of its own (from `session_start`,
// a timer or its hooks). A task's turn is only the run its own prompt joined.
const rpcHost = path.resolve(import.meta.dirname, '../../dist/bin/byok-pi-rpc.js');
const PROVIDER = 'bootstrap-loopback';
const BOOT = 'BYOK-BOOT-2299';
const TASK = 'BYOK-TASK-2299';
const LATER = 'BYOK-LATER-2299';
const PI_TARGET = { lane: 'auto' } as const;
type SessionEvent = Session['events'] extends AsyncIterable<infer Event> ? Event : never;
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Extension source that sets `promptSeen` once Pi has taken the task prompt.
 * Pi's stdin reader is the first `data` listener; this one is attached right
 * after it and, like Pi's, acts only on complete lines. When it sees the
 * prompt line, Pi has already deferred or queued that prompt synchronously.
 */
const PROMPT_WATCH = `import { StringDecoder } from 'node:string_decoder';
let promptSeen = false;
process.stdin.on('newListener', function watch(event) {
  if (event !== 'data') return;
  process.stdin.off('newListener', watch);
  const decoder = new StringDecoder('utf8');
  let pending = '';
  queueMicrotask(() => process.stdin.on('data', chunk => {
    const lines = (pending + (typeof chunk === 'string' ? chunk : decoder.write(chunk))).split('\\n');
    pending = lines.pop();
    if (lines.some(line => line.trim() !== '' && JSON.parse(line).type === 'prompt')) promptSeen = true;
  }));
});
`;

/** An isolated Pi agent directory with one user extension, under the default `inherit` context. */
async function piHome(extension: string, provider: LoopbackProvider, settings: Record<string, unknown> = {}) {
  const box = await createSandbox('pi-boot');
  const agentDir = path.join(box.home, '.pi', 'agent');
  await fs.mkdir(path.join(agentDir, 'extensions'), { recursive: true });
  await fs.writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { [PROVIDER]: {
    baseUrl: provider.baseUrl, api: 'openai-completions', apiKey: 'synthetic',
    models: [{ id: 'm', name: 'm', contextWindow: 32_768, maxTokens: 256, input: ['text'], reasoning: false }],
  } } }));
  await fs.writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: PROVIDER, defaultModel: 'm', ...settings }));
  await fs.writeFile(path.join(agentDir, 'extensions', 'boot.ts'), extension);
  return { box, env: { ...baseEnv(box.home), PI_CODING_AGENT_DIR: agentDir } };
}

/**
 * Replies name the task input they answer; an extension request can be held so
 * its run stays active, or first call the extension tool `tool`.
 */
function provider(holdExtensionMs = 0, tool?: string) {
  return startLoopbackProvider('openai-chat', async request => {
    const task = [`${TASK}-2`, TASK].find(marker => request.text.includes(marker));
    if (task === undefined && holdExtensionMs > 0) await delay(holdExtensionMs);
    const call = task === undefined && request.toolResults === 0 ? request.tools.find(entry => entry.name === tool) : undefined;
    if (call !== undefined) return { kind: 'tool', tool: call, args: {} };
    return { kind: 'text', chunks: [task === undefined ? 'extension reply' : `${task} reply`] };
  });
}

/** One turn's events, failing on a turn that never ends. */
async function turnEvents(session: Session): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  const iterator = session.events[Symbol.asyncIterator]();
  const timeout = delay(20_000).then(() => 'timeout' as const);
  for (;;) {
    const next = await Promise.race([iterator.next(), timeout]);
    if (next === 'timeout') throw new Error(`turn did not end: ${JSON.stringify(events)}`);
    if (next.done) throw new Error(`session ended inside a turn: ${JSON.stringify(events)}`);
    events.push(next.value);
    if (next.value.type === 'turn_end') return events;
  }
}

/** The text of one turn. */
async function turnText(session: Session): Promise<string> {
  return (await turnEvents(session)).flatMap(event => event.type === 'progress' ? [event.text] : []).join('');
}

async function startTask(extension: string, loopback: LoopbackProvider, instruction = `${TASK} reply briefly.`) {
  const { box, env } = await piHome(extension, loopback);
  const adapter = new PiAdapter({ resolveBin: () => ({ command: rpcHost, source: 'package' }), agentUserContext: 'inherit' });
  return { box, session: await startPreparedOperation(adapter, { target: PI_TARGET, instruction }, { workspaceDir: box.workspace, env }) };
}

async function firstTurn(extension: string, loopback: LoopbackProvider, instruction?: string): Promise<string> {
  try {
    const { session } = await startTask(extension, loopback, instruction);
    try { return await turnText(session); } finally { await session.close(); }
  } finally { await loopback.close(); }
}

describe('pi-rpc lane with a user extension that runs Pi itself (#2299)', () => {
  it('a run started from session_start does not refuse the task; the run the task joined ends the turn', async () => {
    expect(await firstTurn(`export default function(pi) {
  pi.on('session_start', () => { pi.sendUserMessage(${JSON.stringify(BOOT)}); });
}\n`, await provider(500))).toContain(`${TASK} reply`);
  }, 60_000);

  it('a run started from a timer after session_start does not refuse the task', async () => {
    expect(await firstTurn(`export default function(pi) {
  pi.on('session_start', () => { setTimeout(() => pi.sendUserMessage(${JSON.stringify(BOOT)}), 0); });
}\n`, await provider(500))).toContain(`${TASK} reply`);
  }, 60_000);

  it('the settlement of a run still in its agent_settled hook does not end the task turn', async () => {
    const text = await firstTurn(`${PROMPT_WATCH}export default function(pi) {
  let settling = false, first = true;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  pi.on('agent_settled', async () => { if (!first) return; first = false; settling = true; while (!promptSeen) await delay(5); });
  pi.on('session_start', async () => { pi.sendUserMessage(${JSON.stringify(BOOT)}); while (!settling) await delay(10); });
}\n`, await provider());
    expect(text).toContain(`${TASK} reply`);
    expect(text).not.toContain('extension reply');
  }, 60_000);

  it('an error from the task prompt\'s own extension hook reaches the task', async () => {
    const loopback = await provider();
    try {
      const { session } = await startTask(`export default function(pi) {
  pi.on('before_agent_start', () => { throw new Error('BYOK-HOOK-2299'); });
}\n`, loopback);
      try {
        const events = await turnEvents(session);
        expect(events.some(event => event.type === 'error' && event.message.includes('BYOK-HOOK-2299'))).toBe(true);
      } finally { await session.close(); }
    } finally { await loopback.close(); }
  }, 60_000);

  it('a prompt queued into an extension run mid tool call reports no result without its call', async () => {
    const loopback = await provider(0, 'slow_2299');
    try {
      const { session } = await startTask(`import { Type } from 'typebox';
${PROMPT_WATCH}export default function(pi) {
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  let running = false;
  pi.registerTool({ name: 'slow_2299', label: 'slow', description: 'Waits.', parameters: Type.Object({}),
    async execute() { running = true; while (!promptSeen) await delay(5); return { content: [{ type: 'text', text: 'slow done' }], details: {} }; } });
  // Pi reads the task prompt only after session_start returns: hold it until the call runs.
  pi.on('session_start', async () => { pi.sendUserMessage(${JSON.stringify(BOOT)}); while (!running) await delay(10); });
}\n`, loopback);
      try {
        const events = await turnEvents(session);
        const calls = new Set(events.flatMap(event => event.type === 'tool_use' ? [event.toolCallId] : []));
        expect(events.filter(event => event.type === 'tool_result' && !calls.has(event.toolCallId))).toEqual([]);
        expect(events.flatMap(event => event.type === 'progress' ? [event.text] : []).join('')).toContain(`${TASK} reply`);
      } finally { await session.close(); }
    } finally { await loopback.close(); }
  }, 60_000);

  it('a first prompt Pi handles without a run ends the turn at once', async () => {
    const loopback = await provider();
    expect(await firstTurn(`export default function(pi) {
  pi.registerCommand('noop-2299', { description: 'no run', handler: async () => {} });
}\n`, loopback, '/noop-2299')).toBe('');
    expect(loopback.requests.filter(request => request.model)).toHaveLength(0);
  }, 60_000);

  it('a run an extension starts after the task run ended is not the next turn', async () => {
    const loopback = await provider();
    try {
      const { box, session } = await startTask(`export default function(pi) {
  let started = false, settled = 0;
  pi.on('agent_end', (_event, ctx) => {
    if (started) return; started = true;
    const later = () => ctx.isIdle() ? pi.sendUserMessage(${JSON.stringify(LATER)}) : setTimeout(later, 5);
    setTimeout(later, 0);
  });
  pi.on('agent_settled', async () => {
    if (++settled === 2) (await import('node:fs')).writeFileSync(process.env.HOME + '/later-settled', '');
  });
}\n`, loopback);
      try {
        expect(await turnText(session)).toContain(`${TASK} reply`);
        await expect.poll(() => existsSync(path.join(box.home, 'later-settled')), { timeout: 10_000 }).toBe(true);
        await session.followUp!({ target: PI_TARGET, instruction: `${TASK}-2 reply briefly.` });
        const second = await turnText(session);
        expect(second).toContain(`${TASK}-2 reply`);
        expect(second).not.toContain('extension reply');
      } finally { await session.close(); }
    } finally { await loopback.close(); }
  }, 60_000);

  it('a first prompt Pi defers and then refuses without a response fails start once the start is aborted (#2300)', async () => {
    const loopback = await provider();
    try {
      // The settle hook compacts after Pi deferred the prompt. Compaction waits
      // until the hook has returned, so the deferred prompt, which Pi runs
      // right after the hook without any I/O, meets the compaction and is
      // refused without a response.
      const { box, env } = await piHome(`${PROMPT_WATCH}export default function(pi) {
  let settling = false, first = true, compacting = false, settled = false;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  pi.on('session_before_compact', async () => {
    compacting = true;
    while (!settled) await delay(5);
    (await import('node:fs')).writeFileSync(process.env.HOME + '/refused', '');
  });
  pi.on('agent_settled', async (_event, ctx) => {
    if (!first) return; first = false; settling = true;
    while (!promptSeen) await delay(5);
    ctx.compact();
    while (!compacting) await delay(5);
    settled = true;
  });
  pi.on('session_start', async () => { pi.sendUserMessage(${JSON.stringify(BOOT)}); while (!settling) await delay(10); });
}\n`, loopback, { compaction: { keepRecentTokens: 1 } });
      let child: ChildProcess | undefined;
      const spawnFn = ((...args: Parameters<SpawnFn>) => (child = spawn(...args))) as SpawnFn;
      const adapter = new PiAdapter({ resolveBin: () => ({ command: rpcHost, source: 'package' }), agentUserContext: 'inherit', spawnFn });
      const deadline = new AbortController();
      const refused = startPreparedOperation(adapter, { target: PI_TARGET, instruction: `${TASK} reply briefly.` },
        { workspaceDir: box.workspace, env, signal: deadline.signal });
      // The abort stands in for the daemon's startup deadline. Once compaction
      // holds, the deferred prompt is refused and no response will ever come.
      await expect.poll(() => existsSync(path.join(box.home, 'refused')), { timeout: 15_000 }).toBe(true);
      deadline.abort();
      const error = await refused.then(() => undefined, (failure: unknown) => failure);
      expect(error).toBeInstanceOf(RuntimeExecutionFailure);
      expect(error).toMatchObject({ phase: 'start', retry: 'retryable' });
      expect((error as Error).message).toContain('the start was aborted before pi answered');
      expect(child!.exitCode !== null || child!.signalCode !== null).toBe(true);
    } finally { await loopback.close(); }
  }, 60_000);

  // `PiSession` reads a turn from this order, which is Pi 1.5.2's
  // implementation, not a documented contract: runs never overlap, and a
  // `started` prompt response is written before that run's `agent_start`.
  // A Pi that changes either fails here.
  it('pinned Pi RPC writes a started prompt response before its run, and runs never overlap', async () => {
    const loopback = await provider(300);
    const { box, env } = await piHome(`export default function(pi) {
  let task = false, later = false;
  pi.on('session_start', () => { setTimeout(() => pi.sendUserMessage(${JSON.stringify(BOOT)}), 0); });
  pi.on('input', event => { if (event.source === 'rpc') task = true; });
  pi.on('agent_end', (_event, ctx) => {
    if (!task || later) return; later = true;
    const send = () => ctx.isIdle() ? pi.sendUserMessage(${JSON.stringify(LATER)}) : setTimeout(send, 5);
    setTimeout(send, 0);
  });
}\n`, loopback);
    const frames: PiRpcMessage[] = [];
    const client = new PiRpcClient({ command: resolvePiBin().command, args: ['--mode', 'rpc'], cwd: box.workspace, env, onFrame: frame => frames.push(frame) });
    const settled = () => frames.filter(frame => frame.type === 'agent_settled').length;
    try {
      await expect.poll(settled, { timeout: 15_000 }).toBe(1);
      const response = await client.send({ id: 'task', type: 'prompt', message: `${TASK} reply briefly.` });
      expect(response).toMatchObject({ success: true, data: { disposition: 'started' } });
      await expect.poll(settled, { timeout: 15_000 }).toBe(3);
      const order = frames.flatMap(frame => frame.type === 'agent_start' || frame.type === 'agent_settled' ? [frame.type]
        : frame.type === 'response' && frame.id === 'task' ? ['task response'] : []);
      expect(order).toEqual(['agent_start', 'agent_settled', 'task response', 'agent_start', 'agent_settled', 'agent_start', 'agent_settled']);
    } finally {
      await client.dispose();
      await loopback.close();
    }
  }, 60_000);
});
