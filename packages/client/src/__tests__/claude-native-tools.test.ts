import { spawn, type SpawnOptions } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAdapter, type ClaudeAdapterOptions, type ClaudeBuiltinToolName } from '../adapters/claude/claude-adapter';
import type { SpawnFn } from '../adapters/claude/process-client';
import type { Session } from '../types';
import { startPreparedOperation } from './fixtures/prepared-operation';
import { observationOf } from './fixtures/mcp-observation';

const fixture = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const mcpFixture = fileURLToPath(new URL('./fixtures/fake-salesko-mcp.mjs', import.meta.url));
const sessions = new Set<Session>();
const directories: string[] = [];

afterEach(async () => {
  await Promise.all([...sessions].map(session => session.close()));
  sessions.clear();
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

async function directory() {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-claude-tools-'));
  directories.push(value);
  return value;
}

function adapter(options: ClaudeAdapterOptions = {}) {
  const launches: string[][] = [];
  const spawnFn = ((command: string, args: readonly string[] = [], childOptions: SpawnOptions = {}) => {
    launches.push([...args]);
    return spawn(command, [...args], childOptions);
  }) as SpawnFn;
  const configuration: ClaudeAdapterOptions = { ...options, resolveBin: () => ({ command: fixture, source: 'path' }), spawnFn };
  return { instance: new ClaudeAdapter(configuration), launches, configuration };
}

async function turn(session: Session) {
  const events = [];
  for await (const event of session.events) {
    events.push(event);
    if (event.type === 'turn_end') break;
  }
  return events;
}

async function start(instance: ClaudeAdapter, home: string, input: { agent?: boolean; sessionRef?: string; artifact?: string; mcp?: boolean } = {}) {
  const session = await startPreparedOperation(instance, {
    instruction: input.mcp ? 'salesko:find-leads' : 'exercise native tools',
    ...(input.sessionRef === undefined ? {} : { sessionRef: input.sessionRef }),
  }, {
    workspaceDir: home,
    ...(input.agent === false ? {} : { agentHome: home }),
    env: { ...process.env, ...(input.artifact === undefined ? {} : { FAKE_CLAUDE_ARTIFACT_PATH: input.artifact }) },
    ...(input.mcp ? {
      mcpServers: { salesko: { command: process.execPath, args: [mcpFixture] } },
      mcpToolsetTools: observationOf({ salesko: ['find_leads'] }),
    } : {}),
  });
  sessions.add(session);
  return session;
}

function toolArgument(args: readonly string[]) {
  const index = args.indexOf('--tools');
  return index < 0 ? undefined : args[index + 1];
}

// The fake proves adapter wiring; native registry and pending-resume behavior
// were qualified with real Claude 2.1.302 in the accompanying evidence note.
describe('Claude Agent native tools', () => {
  it.each([undefined, 'inherit'] as const)('keeps native defaults for %s', async policy => {
    const { instance, launches } = adapter({ agentBuiltinTools: policy });
    const session = await start(instance, await directory());
    expect(await turn(session)).toContainEqual(expect.objectContaining({ type: 'tool_result', tool: 'Bash', isError: false }));
    expect(launches[0]).not.toContain('--tools');
  });

  it('does not apply an Agent restriction to a non-Agent operation', async () => {
    const { instance, launches } = adapter({ agentBuiltinTools: [] });
    const session = await start(instance, await directory(), { agent: false });
    expect(await turn(session)).toContainEqual(expect.objectContaining({ type: 'tool_result', tool: 'Bash', isError: false }));
    expect(launches[0]).not.toContain('--tools');
  });

  it.each([{ names: [] }, { names: ['Read'] }] satisfies { names: ClaudeBuiltinToolName[] }[])('passes the exact native set $names and exposes hostile Bash rejection', async ({ names }) => {
    const { instance, launches } = adapter({ agentBuiltinTools: names });
    const session = await start(instance, await directory());
    expect(toolArgument(launches[0]!)).toBe(names.join(','));
    expect(await turn(session)).toContainEqual(expect.objectContaining({
      type: 'tool_result', tool: 'Bash', isError: true,
      output: { content: expect.stringContaining('No such tool available: Bash') },
    }));
    expect(launches[0]).not.toContain('--allowedTools');
    expect(launches[0]).not.toContain('--disallowedTools');
  });

  it('freezes the constructor policy across mutation, followUp and resume', async () => {
    const names: ClaudeBuiltinToolName[] = ['Read'];
    const options: ClaudeAdapterOptions = { agentBuiltinTools: names };
    const { instance, launches, configuration } = adapter(options);
    names.push('Write');
    configuration.agentBuiltinTools = 'inherit';
    const home = await directory();
    const artifact = path.join(home, 'not-written.txt');
    const session = await start(instance, home, { artifact });
    const denied = expect.objectContaining({ type: 'tool_result', tool: 'Write', isError: true });
    expect(await turn(session)).toContainEqual(denied);
    await session.followUp({ instruction: 'try the old Write again' });
    expect(await turn(session)).toContainEqual(denied);
    expect(launches).toHaveLength(1);
    await session.close();
    sessions.delete(session);
    const resumed = await start(instance, home, { artifact, sessionRef: session.sessionRef });
    expect(await turn(resumed)).toContainEqual(denied);
    expect(launches.map(toolArgument)).toEqual(['Read', 'Read']);
    expect(launches[1]).toContain('--resume');
    expect(launches[1]).toContain(session.sessionRef);
    await expect(fs.access(artifact)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses the new empty set on resume after an allowed writer session', async () => {
    const home = await directory();
    const initial = path.join(home, 'initial.txt');
    const { instance: writer } = adapter({ agentBuiltinTools: ['Write'] });
    const session = await start(writer, home, { artifact: initial });
    expect(await turn(session)).toContainEqual(expect.objectContaining({ type: 'tool_result', tool: 'Write', isError: false }));
    expect(await fs.readFile(initial, 'utf8')).toBe('artifact-body');
    await session.close();
    sessions.delete(session);
    const { instance: reader, launches } = adapter({ agentBuiltinTools: [] });
    const after = path.join(home, 'resume-must-not-write.txt');
    const resumed = await start(reader, home, { sessionRef: session.sessionRef, artifact: after });
    expect(toolArgument(launches[0]!)).toBe('');
    expect(await turn(resumed)).toContainEqual(expect.objectContaining({ type: 'tool_result', tool: 'Write', isError: true }));
    await expect(fs.access(after)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves actual task MCP calls with no native tools on fresh and resumed sessions', async () => {
    const home = await directory();
    const { instance, launches } = adapter({ agentBuiltinTools: [], agentUserContext: 'excluded' });
    const session = await start(instance, home, { mcp: true });
    const success = expect.objectContaining({
      type: 'tool_result', tool: 'mcp__salesko__find_leads', isError: false,
      output: { content: expect.stringContaining('salesko-fake') },
    });
    expect(await turn(session)).toContainEqual(success);
    await session.close();
    sessions.delete(session);
    const resumed = await start(instance, home, { mcp: true, sessionRef: session.sessionRef });
    expect(await turn(resumed)).toContainEqual(success);
    expect(launches.map(toolArgument)).toEqual(['', '']);
    for (const args of launches) {
      expect(args).toContain('--mcp-config');
      expect(args).toContain('--strict-mcp-config');
      expect(args).toContain('--settings');
      expect(args).not.toContain('--allowedTools');
    }
  });

  it.each([
    null, true, 'Read', 'default', ['DefinitelyNotAClaudeTool1061'],
    ['Read', 'DefinitelyNotAClaudeTool1061'], ['read'], [' Read'], [''],
    ['Bash(git *)'], ['Read,Write'], ['mcp__salesko__find_leads'], ['Task'],
    ['Read', 'Read'], [undefined], Array(1),
  ].map(value => ({ value })))('rejects invalid policy $value before resolving or spawning any CLI', ({ value }) => {
    const resolveBin = vi.fn();
    const spawnFn = vi.fn();
    expect(() => Reflect.construct(ClaudeAdapter, [{ agentBuiltinTools: value, resolveBin, spawnFn }])).toThrow(TypeError);
    expect(resolveBin).not.toHaveBeenCalled();
    expect(spawnFn).not.toHaveBeenCalled();
  });
});
