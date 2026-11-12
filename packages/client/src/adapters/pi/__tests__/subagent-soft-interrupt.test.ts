import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createPiSubagentAbortBoundary } from '../subagent-interruption';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PiAdapter } from '../pi-adapter';
import { startPreparedOperation } from '../../../__tests__/fixtures/prepared-operation';
import type { Session } from '../../../types';

const snapshot = (active: boolean) => ({ asyncSnapshot: {
  kind: 'pi-subagents.async-status-snapshot', version: 1, omitted: { runs: 0, byteLimitExceeded: false },
  runs: active ? [{ id: 'run', kind: 'subagent', state: 'running' }] : [],
} });
const proof = (state = 'observed', instance = 'instance') => ({
  version: 1, runId: 'run', runnerProcessInstanceId: instance, state, observedAt: 1,
  instances: [{ kind: 'runner', processInstanceId: instance }],
});
async function controlFixture(native: (method: string, params?: { id: string }) => unknown, ready = true) {
  const bus = new EventEmitter(), handlers = new Map<string, (event: { toolName: string; toolCallId: string }) => void>();
  const boundary = createPiSubagentAbortBoundary();
  const events = {
    on: (event: string, handler: (value: unknown) => void) => { bus.on(event, handler); return () => { bus.off(event, handler); }; },
    emit: (event: string, value: unknown) => { bus.emit(event, value); },
  };
  await boundary.factory({ events, on: (event: string, handler: (value: { toolName: string; toolCallId: string }) => void) => { handlers.set(event, handler); } } as never);
  bus.on('subagents:rpc:v1:request', ({ requestId, method, params }) => {
    void Promise.resolve(native(method, params)).then(data => bus.emit(`subagents:rpc:v1:reply:${requestId}`, { version: 1, requestId, success: true, data }));
  });
  let aborts = 0;
  const session = { abort: async () => { aborts += 1; } };
  boundary.bind(session as never);
  if (ready) events.emit('subagents:rpc:v1:ready', {});
  return { session, events, bus, handlers, get aborts() { return aborts; } };
}

it.each([false, true])('preserves native abort with no background work (owner ready: %s)', async ready => {
  let requests = 0;
  const f = await controlFixture(() => { requests += 1; return snapshot(false); }, ready);
  await f.session.abort();
  expect(f.aborts).toBe(1);
  expect(requests).toBe(ready ? 1 : 0);
});

it.each([false, true])('waits beyond a stop acknowledgment for native proof (launch in flight: %s)', async lateLaunch => {
  let born = !lateLaunch, stopped = false, terminal = false, finished = false;
  const f = await controlFixture((method, params) => {
    if (method === 'stop') { stopped = true; return { runId: 'run', state: 'stopping' }; }
    if (params) return { details: { lifecycleStatus: { processTerminal: proof(terminal ? 'observed' : 'pending') } } };
    const result = snapshot(born);
    if (!born) queueMicrotask(() => { born = true; f.handlers.get('tool_execution_end')!({ toolName: 'subagent', toolCallId: 'launch' }); });
    return result;
  });
  if (lateLaunch) f.handlers.get('tool_execution_start')!({ toolName: 'subagent', toolCallId: 'launch' });
  const shared = f.session.abort();
  const interrupt = shared.then(() => { finished = true; });
  expect(f.session.abort()).toBe(shared); // Repeated aborts share the same native cancellation.
  await expect.poll(() => stopped).toBe(true);
  expect(finished).toBe(false);
  terminal = true;
  await interrupt;
  expect(f.aborts).toBe(1);
});

it.each(['truncated', 'malformed', 'unknown-proof', 'foreign-proof', 'wrong-instance', 'unproven-exit', 'bad-stop'])('refuses %s control evidence', async scenario => {
  let reads = 0;
  const f = await controlFixture((method, params) => {
    if (method === 'stop') return { runId: scenario === 'bad-stop' ? 'foreign' : 'run', state: 'stopping' };
    if (!params) {
      if (scenario === 'malformed') return {};
      const result = snapshot(true);
      if (scenario === 'truncated') result.asyncSnapshot.omitted.runs = 1;
      return result;
    }
    const terminal = scenario === 'unknown-proof' ? proof('unknown') : scenario === 'wrong-instance'
      ? reads++ === 0 ? proof('pending') : proof('observed', 'other') : proof();
    if (scenario === 'foreign-proof') terminal.runId = 'foreign';
    if (scenario === 'unproven-exit') terminal.instances = [];
    if (scenario === 'bad-stop') terminal.state = 'pending';
    return { details: { lifecycleStatus: { processTerminal: terminal } } };
  });
  await expect(f.session.abort()).rejects.toThrow('pi_subagent_interrupt_unverified');
});

it.each(['observed', 'open-dispatch', 'pending-child', 'foreign-root', 'unknown'])('checks native workflow terminal evidence: %s', async scenario => {
  const f = await controlFixture((_method, params) => params ? { details: { workflowTerminalProof: {
    version: 1, kind: 'workflow', runId: scenario === 'foreign-root' ? 'foreign' : 'run',
    state: scenario === 'unknown' ? 'unknown' : 'observed', dispatchClosed: scenario !== 'open-dispatch',
    children: [proof(scenario === 'pending-child' ? 'pending' : 'observed')],
  } } } : snapshot(true));
  if (scenario === 'observed') await expect(f.session.abort()).resolves.toBeUndefined();
  else await expect(f.session.abort()).rejects.toThrow('pi_subagent_interrupt_unverified');
});

it.each(['missing', 'foreign', 'refused'])('rejects a %s control reply', async scenario => {
  vi.useFakeTimers();
  try {
    const f = await controlFixture(() => snapshot(false));
    f.bus.removeAllListeners('subagents:rpc:v1:request');
    f.bus.on('subagents:rpc:v1:request', ({ requestId }) => {
      if (scenario !== 'missing') f.bus.emit(`subagents:rpc:v1:reply:${requestId}`, {
        version: 1, requestId: scenario === 'foreign' ? 'other' : requestId, success: false, error: { code: 'execution_failed' },
      });
    });
    const rejected = expect(f.session.abort()).rejects.toThrow('pi_subagent_interrupt_unverified');
    if (scenario === 'missing') await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
  } finally { vi.useRealTimers(); }
});

it('soft interrupt stops and awaits a background child, then preserves the parent session (#1949)', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'byok-pi-interrupt-'));
  const cwd = path.join(root, 'workspace'), agentDir = path.join(root, 'agent');
  await mkdir(cwd); await mkdir(path.join(agentDir, 'agents'), { recursive: true });
  await writeFile(path.join(agentDir, 'agents/interrupt-child.md'), '---\nname: interrupt-child\ndescription: Synthetic interrupt probe\nmodel: interrupt-loopback/probe\ntools: read\n---\nWait for the synthetic provider.');
  let parentRequests = 0, childRequests = 0, childClosed = false;
  let childResponse: ServerResponse | undefined, parentResponse: ServerResponse | undefined;
  const server = createServer(async (request, response) => {
    let text = ''; for await (const chunk of request) text += chunk;
    const body = JSON.parse(text) as { tools?: { function?: { name?: string } }[] };
    const parent = body.tools?.some(tool => tool.function?.name === 'subagent');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (!parent) {
      childRequests += 1; childResponse = response; response.flushHeaders();
      response.on('close', () => { childClosed = true; });
      return;
    }
    parentRequests += 1;
    if (parentRequests === 2) { parentResponse = response; response.flushHeaders(); return; }
    const tool = parentRequests === 1 ? { name: 'subagent', arguments: JSON.stringify({
      agent: 'interrupt-child', task: 'Hold the child request', async: true, context: 'fresh', output: false, artifacts: false,
    }) } : undefined;
    const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'child-launch', type: 'function', function: tool }] }
      : { role: 'assistant', content: 'parent complete' };
    response.end(`data: ${JSON.stringify({ id: 'probe', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'probe', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing loopback address');
  await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { 'interrupt-loopback': {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'synthetic',
    models: [{ id: 'probe', name: 'probe', contextWindow: 8192, maxTokens: 32, input: ['text'], reasoning: false }],
  } } }));
  await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'interrupt-loopback', defaultModel: 'probe' }));
  let session: Session | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const adapter = new PiAdapter({ resolveBin: () => ({ command: path.resolve(import.meta.dirname, '../../../../dist/bin/byok-pi-rpc.js'), source: 'package' }) });
    session = await startPreparedOperation(adapter, { instruction: 'Delegate a background child, then finish the parent response.' }, {
      workspaceDir: cwd, agentHome: cwd,
      env: { HOME: root, PATH: process.env.PATH!, PI_CODING_AGENT_DIR: agentDir, PI_SUBAGENTS_TEMP_ROOT: path.join(root, 'subagents') },
    });
    let asyncDir = '', runId = '';
    const events = (async () => {
      try {
        for await (const event of session!.events) {
          if (event.type === 'tool_result' && event.tool === 'subagent') {
            const result = event.output as { result: { details: { asyncDir: string; asyncId: string } } };
            asyncDir = result.result.details.asyncDir; runId = result.result.details.asyncId;
          }
        }
      } catch (error) { return error; }
    })();
    await expect.poll(() => Boolean(asyncDir) && childRequests === 1 && parentRequests >= 2, { timeout: 10_000 }).toBe(true);
    await Promise.race([session.interrupt(), new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('soft interrupt did not stop its background child')), 5_000);
    })]);
    clearTimeout(deadline);
    const proof = JSON.parse(await readFile(path.join(asyncDir, 'process-terminal.json'), 'utf8'));
    expect(proof).toMatchObject({ runId, state: 'observed' });
    expect(proof.instances.some((instance: { kind: string }) => instance.kind === 'runner')).toBe(true);
    expect(childClosed).toBe(true);
    expect(childRequests).toBe(1);
    await expect(events).resolves.toMatchObject({ message: 'pi run aborted before completion' });
    await session.followUp({ instruction: 'Complete a normal parent response after the interrupt.' });
    const types: string[] = [];
    for await (const event of session.events) { types.push(event.type); if (event.type === 'turn_end') break; }
    expect(types.at(-1)).toBe('turn_end');
    expect(childRequests).toBe(1);
  } finally {
    clearTimeout(deadline); childResponse?.end('data: [DONE]\n\n'); parentResponse?.end('data: [DONE]\n\n');
    await session?.close();
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 30_000);
