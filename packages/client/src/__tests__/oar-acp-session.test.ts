import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acpSession, type AcpSessionHooks } from '../../vendor/oar/c264f17/shared/acp/session';
import type { AcpSessionProfile } from '../../vendor/oar/c264f17/shared/acp/profile';
import type { AdapterSession, RawEvent, RequestRecord } from '../../vendor/oar/c264f17/contracts/session';
import { spawnOwnedLineProcess } from '../runtime/owned-line-process';
import { createOwnedTerminalSpawn, spawnOwnedTerminalProcess } from '../runtime/owned-terminal-process';
import { __hostExitBackstopForTests } from '../adapters/process-tree';

const FAKE = path.join(import.meta.dirname, 'fixtures/fake-acp-agent.mjs');
// A runtime-neutral profile: the shared stack under test, not a vendor's.
const profile: AcpSessionProfile = {
  args: ['agent', 'stdio'],
  capabilities: { queue: { durable: false }, attribution: 'nested' },
  terminalShellCommand: true,
  selectAuthMethod: () => 'cached_token',
};
const start = acpSession(profile);
const live: AdapterSession[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const session of live.splice(0)) await session.dispose().catch(() => {});
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

function workspace() {
  const dir = mkdtempSync(path.join(tmpdir(), 'byok-acp-'));
  dirs.push(dir);
  return { dir, log: path.join(dir, 'agent.log') };
}
function facts(log: string): Array<Record<string, any>> {
  return readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line));
}
async function open(env: Record<string, string>, cwd: string, hooks: AcpSessionHooks = {}, spawnTerminal = spawnOwnedTerminalProcess) {
  const session = await start(spawnOwnedLineProcess, spawnTerminal, { kind: 'available', via: 'executable', command: FAKE }, { cwd, env }, hooks);
  live.push(session);
  return session;
}
async function turn(session: AdapterSession, records: RawEvent[], input: string): Promise<void> {
  const ended = new Promise<void>(resolve => session.rawEvents(record => {
    if (record.kind === 'frame' && record.body.events.some(event => event.kind === 'turn_ended')) resolve();
  }));
  expect((await session.prompt(input)).response.body.kind).toBe('accepted');
  await ended;
  expect(records.length).toBeGreaterThan(0);
}

describe('vendored OAR ACP session over SDK-owned processes', () => {
  it('passes exactly the explicit env to the agent and to hosted terminals', async () => {
    vi.stubEnv('BYOK_ACP_AMBIENT_SECRET', 'must not inherit');
    const { dir, log } = workspace();
    const records: RawEvent[] = [];
    const env = { PATH: process.env.PATH ?? '', FAKE_ACP_LOG: log };
    const session = await open(env, dir, { onRecord: record => records.push(record) });
    await turn(session, records, 'terminal');
    const [started] = facts(log).filter(fact => fact.kind === 'start');
    // Node's macOS spawn adds this platform baseline independently of the caller env.
    delete started!.env.__CF_USER_TEXT_ENCODING;
    expect(started!.env).toEqual(env);
    expect(started!.argv).toEqual(['agent', 'stdio']);
    const done = facts(log).find(fact => fact.kind === 'terminal-done');
    // The request's env entry overlays the session env inside the terminal.
    expect(done?.output.output).toBe('terminal-ok');
    expect(done?.exit.exitCode).toBe(0);
  });

  it('answers every permission request cancelled and records the request and answer', async () => {
    const { dir, log } = workspace();
    const records: RawEvent[] = [];
    const session = await open({ PATH: process.env.PATH ?? '', FAKE_ACP_LOG: log }, dir, { onRecord: record => records.push(record) });
    await turn(session, records, 'permission');
    expect(facts(log).find(fact => fact.kind === 'permission')?.reply).toEqual({ outcome: { outcome: 'cancelled' } });
    const request = records.find((record): record is RequestRecord => record.kind === 'request' && record.body.kind === 'native' && record.body.type === 'session/request_permission');
    expect(request).toBeDefined();
    expect(records.some(record => record.kind === 'response' && record.requestId === request!.id && record.body.kind === 'answered')).toBe(true);
  });

  it('reaps a hosted terminal tree when the session is disposed mid-turn', async () => {
    const { dir, log } = workspace();
    const records: RawEvent[] = [];
    const children: number[] = [];
    const spawnTerminal = createOwnedTerminalSpawn({
      spawnFn: (command, args, options) => {
        const child = spawn(command, [...args], options);
        if (child.pid !== undefined) children.push(child.pid);
        return child;
      },
    });
    const session = await open({ PATH: process.env.PATH ?? '', FAKE_ACP_LOG: log }, dir, { onRecord: record => records.push(record) }, spawnTerminal);
    expect((await session.prompt('terminal-hang')).response.body.kind).toBe('accepted');
    await vi.waitFor(() => expect(facts(log).some(fact => fact.kind === 'terminal')).toBe(true));
    expect(children).toHaveLength(1);
    expect(__hostExitBackstopForTests.registeredPids()).toContain(children[0]);
    await session.dispose();
    expect(__hostExitBackstopForTests.registeredPids()).not.toContain(children[0]);
    if (process.platform !== 'win32') expect(() => process.kill(-children[0]!, 0)).toThrow();
  });

  it('reports a failed terminal reap and reaps the tree on the next dispose', async () => {
    const { dir, log } = workspace();
    const children: number[] = [];
    let failOnce = true;
    const owned = createOwnedTerminalSpawn({
      spawnFn: (command, args, options) => {
        const child = spawn(command, [...args], options);
        if (child.pid !== undefined) children.push(child.pid);
        return child;
      },
    });
    const spawnTerminal: typeof spawnOwnedTerminalProcess = (command, args, options) => {
      const terminal = owned(command, args, options);
      return {
        ...terminal,
        dispose: () => {
          if (!failOnce) return terminal.dispose();
          failOnce = false;
          return Promise.reject(new Error('terminal tree did not quiesce'));
        },
      };
    };
    const session = await open({ PATH: process.env.PATH ?? '', FAKE_ACP_LOG: log }, dir, {}, spawnTerminal);
    expect((await session.prompt('terminal-hang')).response.body.kind).toBe('accepted');
    await vi.waitFor(() => expect(facts(log).some(fact => fact.kind === 'terminal')).toBe(true));
    await expect(session.dispose()).rejects.toThrow('terminal tree did not quiesce');
    expect(__hostExitBackstopForTests.registeredPids()).toContain(children[0]);
    await session.dispose();
    expect(__hostExitBackstopForTests.registeredPids()).not.toContain(children[0]);
    if (process.platform !== 'win32') expect(() => process.kill(-children[0]!, 0)).toThrow();
  });

  it('fails the session through onLimit when retained records exceed the byte budget', async () => {
    const { dir } = workspace();
    const onLimit = vi.fn((): never => { throw new Error('acp retained record byte budget exceeded'); });
    const session = await open({ PATH: process.env.PATH ?? '' }, dir, { maxBytes: 64 * 1024, onLimit });
    expect((await session.prompt('huge')).response.body.kind).toBe('accepted');
    await vi.waitFor(() => expect(onLimit).toHaveBeenCalled());
  });

  it('releases the agent when onReady refuses the opened session', async () => {
    const { dir, log } = workspace();
    await expect(start(spawnOwnedLineProcess, spawnOwnedTerminalProcess, { kind: 'available', via: 'executable', command: FAKE }, {
      cwd: dir, env: { PATH: process.env.PATH ?? '', FAKE_ACP_LOG: log },
    }, { onReady: () => { throw new Error('unexpected session id'); } })).rejects.toThrow('unexpected session id');
    const [started] = facts(log).filter(fact => fact.kind === 'start');
    if (process.platform !== 'win32') expect(() => process.kill(started!.pid, 0)).toThrow();
  });
});
