import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acpSession, type AcpSessionHooks } from '../../vendor/oar/45488e7/shared/acp/session';
import type { AcpSessionProfile } from '../../vendor/oar/45488e7/shared/acp/profile';
import type { AdapterSession, RawEvent, RequestRecord } from '../../vendor/oar/45488e7/contracts/session';
import { grokFailureOutcome } from '../../vendor/oar/45488e7/runtimes/grok/failure';
import { spawnOwnedLineProcess } from '../runtime/owned-line-process';
import { createOwnedTerminalSpawn, spawnOwnedTerminalProcess } from '../runtime/owned-terminal-process';
import { __hostExitBackstopForTests } from '../adapters/process-tree';
import { createAcpTurns } from '../../vendor/oar/45488e7/shared/acp/turns';
import { createUsageUpdateGate } from '../../vendor/oar/45488e7/shared/acp/profile';
import type { AcpProcess } from '../../vendor/oar/45488e7/shared/acp/process';
import { createSessionKernel } from '../../vendor/oar/45488e7/shared/session-kernel';
import { antigravityAcpProfile } from '../../vendor/oar/45488e7/runtimes/antigravity/session';

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
  it.each(['spawn', 'dispatch'].flatMap(wait => ['settlement', 'interrupt'].map(transition => ({ wait, transition }))))('rejects a steer waiting on $wait after $transition', async ({ wait, transition }) => {
    const gate = Promise.withResolvers<void>();
    const reply = Promise.withResolvers<{ stopReason: string }>();
    let waiting = false;
    let spawnReads = 0;
    const request = vi.fn(() => reply.promise);
    const runtime = {
      get spawned() {
        if (!waiting) return Promise.resolve();
        const read = ++spawnReads;
        return wait === 'dispatch' && read === 1 ? Promise.resolve() : gate.promise;
      }, closed: false, exitCode: null,
      connection: { agent: { request, notify: vi.fn(async () => {}) } },
      observeDescendants: () => {},
    } as unknown as AcpProcess;
    const kernel = createSessionKernel('race');
    const turns = createAcpTurns({ kernel, runtime, profile: antigravityAcpProfile,
      usageGate: createUsageUpdateGate(), capabilities: { images: false }, promptUsage: () => null });
    expect(turns.begin(null, 'first').kind).toBe('accepted');
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    const state = turns.active()!;
    waiting = true;
    const steer = turns.steer(state, 'second', undefined, {});
    await vi.waitFor(() => expect(spawnReads).toBe(wait === 'dispatch' ? 2 : 1));
    if (transition === 'interrupt') await turns.abort(state);
    else {
      reply.resolve({ stopReason: 'end_turn' });
      await vi.waitFor(() => expect(turns.active()).toBeNull());
    }
    gate.resolve();
    expect(await steer).toEqual({ kind: 'rejected', code: 'no_active_turn', reason: 'not_steerable: no active turn' });
    if (transition === 'interrupt') reply.resolve({ stopReason: 'end_turn' });
    await vi.waitFor(() => expect(turns.active()).toBeNull());
    expect(request).toHaveBeenCalledTimes(1);
    expect(kernel.records().flatMap(record => record.kind === 'frame' ? record.body.events : []).filter(event => event.kind === 'turn_ended')).toHaveLength(1);
  });
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

  it('records a notification read with the prompt error before the failed turn reads its frames', async () => {
    // Grok's failure reader on the neutral profile: the -32603 class comes
    // from the retry_state notification that shares the error's pipe read.
    const startWithReader = acpSession({ ...profile, extensionNotifications: ['_x.ai/session_notification'], failureOutcome: grokFailureOutcome });
    const { dir } = workspace();
    const records: RawEvent[] = [];
    const session = await startWithReader(spawnOwnedLineProcess, spawnOwnedTerminalProcess, { kind: 'available', via: 'executable', command: FAKE }, {
      cwd: dir, env: { PATH: process.env.PATH ?? '' },
    }, { onRecord: record => records.push(record) });
    live.push(session);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const since = records.length;
      await turn(session, records, 'retry-failed-one-write:context_length');
      const frames = records.slice(since).filter((record): record is Extract<RawEvent, { kind: 'frame' }> => record.kind === 'frame');
      const retry = frames.find(frame => frame.body.type === '_x.ai/session_notification');
      const failed = frames.find(frame => frame.body.type === 'session/prompt/error');
      expect(retry?.seq).toBeLessThan(failed!.seq);
      expect(failed!.body.events).toContainEqual({ kind: 'turn_ended', outcome: { kind: 'failed', reason: 'Internal error', failure: 'input_too_large' } });
    }
  });

  it('holds queued input until its adapter acceptance is recorded, then records the drain as a prompt that carries it', async () => {
    const { dir, log } = workspace();
    const records: RawEvent[] = [];
    const session = await open({ PATH: process.env.PATH ?? '', FAKE_ACP_LOG: log, FAKE_ACP_REPLY_GATE: dir }, dir, { onRecord: record => records.push(record) });
    expect((await session.prompt('first')).response.body.kind).toBe('accepted');
    expect((await session.queue('second', { inputId: 'queued-1' })).response.body).toMatchObject({ kind: 'accepted', queued: 'adapter' });
    expect((await session.prompt('third')).response.body).toMatchObject({ kind: 'rejected', code: 'busy' });
    const drained = new Promise<RequestRecord>(resolve => session.rawEvents(record => {
      if (record.kind === 'request' && record.body.kind === 'prompt' && record.body.input === 'second') resolve(record);
    }));
    writeFileSync(path.join(dir, 'release'), '');
    const request = await drained;
    expect(request.body).toMatchObject({ kind: 'prompt', carries: ['queued-1'] });
    await vi.waitFor(() => expect(records.some(record => record.kind === 'frame' && record.seq > request.seq && record.body.events.some(event => event.kind === 'turn_ended'))).toBe(true));
    expect(records.some(record => record.kind === 'response' && record.requestId === request.id && record.body.kind === 'accepted')).toBe(true);
  });

  it('confirms a config option update from the session notification before the open settles', async () => {
    const { dir, log } = workspace();
    const startConfirming = acpSession({ ...profile, modelViaConfigOption: true, confirmConfigOptionUpdates: true });
    const session = await startConfirming(spawnOwnedLineProcess, spawnOwnedTerminalProcess, { kind: 'available', via: 'executable', command: FAKE }, { cwd: dir, env: { PATH: process.env.PATH ?? '', FAKE_ACP_LOG: log }, model: 'fake-model' });
    live.push(session);
    expect(facts(log).find(fact => fact.kind === 'config')?.params).toMatchObject({ configId: 'model', value: 'fake-model' });
  });

  it('settles a superseding steer on the latest prompt answer, not on the early answer to the first', async () => {
    const { dir, log } = workspace();
    const records: RawEvent[] = [];
    const startSteering = acpSession({ ...profile, steerParams: () => ({}), steerSupersedesPrompt: true, steerOutcomeIsLatest: true });
    const session = await startSteering(spawnOwnedLineProcess, spawnOwnedTerminalProcess, { kind: 'available', via: 'executable', command: FAKE },
      { cwd: dir, env: { PATH: process.env.PATH ?? '', FAKE_ACP_LOG: log, FAKE_ACP_REPLY_GATE: dir } }, { onRecord: record => records.push(record) });
    live.push(session);
    const turnsEnded = () => records.flatMap(record => record.kind === 'frame' ? record.body.events.filter(event => event.kind === 'turn_ended') : []);
    expect((await session.prompt('steer-first')).response.body.kind).toBe('accepted');
    expect((await session.steer!('steer-second')).response.body.kind).toBe('accepted');
    await vi.waitFor(() => expect(records.some(record => record.kind === 'frame' && record.body.type === 'session/prompt')).toBe(true));
    expect(turnsEnded()).toEqual([]);
    expect((await session.prompt('third')).response.body).toMatchObject({ kind: 'rejected', code: 'busy' });
    writeFileSync(path.join(dir, 'release'), '');
    await vi.waitFor(() => expect(turnsEnded()).toEqual([{ kind: 'turn_ended', outcome: { kind: 'completed' } }]));
  });

  it.each([true, false])('attributes a late steer failure with steerOutcomeIsLatest=%s', async (latest) => {
    const { dir, log } = workspace();
    const records: RawEvent[] = [];
    const startSteering = acpSession({ ...profile, steerParams: () => ({}), steerSupersedesPrompt: true, ...(latest ? { steerOutcomeIsLatest: true } : {}) });
    const session = await startSteering(spawnOwnedLineProcess, spawnOwnedTerminalProcess, { kind: 'available', via: 'executable', command: FAKE },
      { cwd: dir, env: { PATH: process.env.PATH ?? '', FAKE_ACP_LOG: log, FAKE_ACP_REPLY_GATE: dir } }, { onRecord: record => records.push(record) });
    live.push(session);
    expect((await session.prompt('steer-first')).response.body.kind).toBe('accepted');
    expect((await session.steer!('steer-fail', { inputId: 'steer-1' })).response.body.kind).toBe('accepted');
    await vi.waitFor(() => expect(records.some(record => record.kind === 'frame' && record.body.type === 'session/prompt')).toBe(true));
    writeFileSync(path.join(dir, 'release'), '');
    await vi.waitFor(() => expect(records.some(record => record.kind === 'frame' && record.body.type === 'session/prompt/error')).toBe(true));
    const events = records.flatMap(record => record.kind === 'frame' ? record.body.events : []);
    expect(events.filter(event => event.kind === 'turn_ended')).toEqual([{ kind: 'turn_ended', outcome: latest ? { kind: 'failed', reason: 'Internal error', failure: 'provider', fromText: true } : { kind: 'completed' } }]);
    expect(events.filter(event => event.kind === 'input_dropped')).toEqual(latest ? [] : [{ kind: 'input_dropped', inputId: 'steer-1', reason: 'runtime_refused' }]);
  });

  it('delivers every record from seq 0 to the record consumer and swallows its errors', async () => {
    const { dir } = workspace();
    const seen: RawEvent[] = [];
    const session = await open({ PATH: process.env.PATH ?? '' }, dir, {
      onRecord: record => { seen.push(record); throw new Error('consumer failed'); },
    });
    expect((await session.prompt('huge')).response.body.kind).toBe('accepted');
    expect(seen[0]!.seq).toBe(0);
    expect(seen).toEqual(session.records());
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
