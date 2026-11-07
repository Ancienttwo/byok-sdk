import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentSession, createAgentSessionRuntime, createAgentSessionServices, SessionManager, SettingsManager, type ExtensionAPI, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { resolveFileScopeGrant, nodeFileScopeIo } from '../file-scope-guard';
import { SCOPED_FILE_TOOL_NAMES } from '../file-scope-types';
import { createPiMemoryLane, assertPiMemoryToolLoadout, PiMemoryLaneError, PI_MEMORY_LANE } from '../bin/pi-memory-lane';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const cwd = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'memory-lane-')));
  roots.push(cwd);
  const grant = await resolveFileScopeGrant({ fileScope: { mode: 'memory' }, home: { path: cwd, identity: await fs.stat(cwd, { bigint: true }) }, attempt: { homeAccess: 'writer' } });
  return { cwd, grant };
}

it('asserts the exact registered and active SDK tool set before prompting', () => {
  const view = (names: readonly string[]) => ({ getAllTools: () => names.map(name => ({ name, sourceInfo: { path: '<sdk:' + name + '>', source: 'sdk' } })), getActiveToolNames: () => names });
  expect(() => assertPiMemoryToolLoadout(view(SCOPED_FILE_TOOL_NAMES))).not.toThrow();
  for (const names of [[...SCOPED_FILE_TOOL_NAMES, 'bash'], SCOPED_FILE_TOOL_NAMES.slice(1)]) {
    expect(() => assertPiMemoryToolLoadout(view(names))).toThrow(PiMemoryLaneError);
  }
});

it.skipIf(process.platform === 'win32')('directly rejects every other tool without an approval transport', async () => {
  const { grant } = await fixture();
  const lane = createPiMemoryLane({ grant });
  const handlers = new Map<string, (event: { toolName: string }) => unknown>();
  const registerTool = vi.fn();
  lane.extension({ registerTool, on: (event: string, handler: (event: { toolName: string }) => unknown) => handlers.set(event, handler) } as unknown as ExtensionAPI);
  expect(lane.toolOptions.customTools!.map(tool => tool.name).sort()).toEqual([...SCOPED_FILE_TOOL_NAMES].sort());
  for (const toolName of ['bash', 'mcp__secret', 'web', 'todo', 'subagent', 'result-document']) {
    expect(await handlers.get('tool_call')!({ toolName })).toMatchObject({ block: true });
  }
});

it.skipIf(process.platform === 'win32')('refuses writes after cancellation and drains a write already inside the guard', async () => {
  const { cwd, grant } = await fixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const lane = createPiMemoryLane({ grant, io: { ...nodeFileScopeIo, stat: async path => { entered(); await blocked; return nodeFileScopeIo.stat(path); } } });
  const write = lane.tools.find(tool => tool.name === 'write')!;
  const execute = (signal?: AbortSignal) => (write.execute as ToolDefinition['execute'])('w', { path: 'MEMORY.md', content: 'done' }, signal, undefined, { cwd } as never);
  const pending = execute();
  await started;
  let ended = false;
  const closing = lane.close().then(() => { ended = true; });
  await Promise.resolve();
  expect(ended).toBe(false);
  await expect(execute()).rejects.toMatchObject({ code: 'memory_lane_closed' });
  release();
  await pending; await closing;
  expect(await fs.readFile(join(cwd, 'MEMORY.md'), 'utf8')).toBe('done');
  const fresh = createPiMemoryLane({ grant });
  await expect(fresh.tools.find(tool => tool.name === 'write')!.execute('late', { path: 'MEMORY.md', content: 'late' }, AbortSignal.abort(), undefined, { cwd } as never)).rejects.toMatchObject({ code: 'memory_lane_closed' });
});

it.skipIf(process.platform === 'win32')('uses real Pi with no session file, instruction resources or RPC escape routes', async () => {
  const { cwd, grant } = await fixture();
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'SYSTEM.md', 'APPEND_SYSTEM.md']) await fs.writeFile(join(cwd, name), 'INSTRUCTION_CANARY');
  const lane = createPiMemoryLane({ grant });
  const manager = SessionManager.inMemory(cwd);
  const services = await createAgentSessionServices({ cwd, agentDir: cwd, settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }), resourceLoaderOptions: lane.resourceLoaderOptions });
  const runtime = await createAgentSessionRuntime(async () => ({ ...await createAgentSession({ sessionManager: manager, ...services, ...lane.toolOptions }), services, diagnostics: [] }), { cwd, agentDir: cwd, sessionManager: manager });
  lane.bindRuntime(runtime);
  try {
    assertPiMemoryToolLoadout(runtime.session);
    expect(services.resourceLoader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(runtime.session.systemPrompt).not.toContain('INSTRUCTION_CANARY');
    manager.appendMessage({ role: 'user', content: 'proof', timestamp: Date.now() });
    manager.appendMessage({ role: 'assistant', content: [], api: 'anthropic-messages', provider: 'anthropic', model: 'proof', stopReason: 'stop', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    expect(manager.isPersisted()).toBe(false);
    expect(manager.getSessionFile()).toBeUndefined();
    expect((await fs.readdir(cwd, { recursive: true })).filter(file => file.endsWith('.jsonl'))).toEqual([]);
    for (const attempt of [() => runtime.newSession(), () => runtime.switchSession('/invalid'), () => runtime.fork('invalid'), () => runtime.session.executeBash('echo escape'), () => runtime.session.exportToHtml(join(cwd, 'export.html'))]) {
      await expect(attempt()).rejects.toMatchObject({ code: 'memory_lane_operation_denied' });
    }
    await runtime.session.abort();
    await expect(runtime.session.prompt('late')).rejects.toMatchObject({ code: 'memory_lane_closed' });
    expect(PI_MEMORY_LANE.egress).toEqual({ taskProgress: false, summary: '', finalMessage: false, resultDocument: false });
  } finally { await runtime.dispose(); }
});
