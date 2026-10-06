import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { AgentEvent } from '@byok-sdk/protocol';
import { startDurablePi, type DurableStart } from '../adapters/pi-durable/session';
import type { Session } from '../types';

interface WorkerPlan {
  result?: 'saved' | 'reordered' | 'conflict' | 'nested-conflict' | 'invalid' | 'none';
  complete?: boolean;
  duplicate?: boolean;
  crash?: boolean;
  projectionDigest?: string;
}
const roots: string[] = [];
const sessions: Session[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const expectedDocument = { text: 'finished', detail: { count: 1, labels: ['a', 'b'] } };
async function fixture(plan: WorkerPlan[]) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'fix-pi-durable-recovery-')));
  roots.push(root);
  const home = path.join(root, 'home');
  await mkdir(home);
  await writeFile(path.join(root, 'plan.json'), JSON.stringify(plan));
  const journal: string[] = [];
  const children: ChildProcess[] = [];
  const release = vi.fn(async () => {});
  // Exercise real binding checks with the explicit unconfigured development
  // identity. The injected spawn launches only our inert fixture, never Pi.
  const binding = { format: 'byok.implementation-spawn' as const, version: 1 as const,
    identity: { kind: 'unavailable' as const, reason: 'resolver_unconfigured' as const },
    command: process.execPath, fixedArgv: [], cwd: root, envCommitments: {} };
  const session = await startDurablePi({
    input: {
      instruction: 'synthetic instruction', mcpEnv: {},
      manifest: { taskId: 'task', cwd: home,
        agentRef: { agentId: 'agent', profileRevision: 'revision' },
        lease: { leaseId: 'lease', canonicalHome: home },
        dispatchSelection: { lane: 'byok', runtimeId: 'pi', providerId: 'probe', modelId: 'test' } },
      durableContext: { tenantId: 'tenant', lifecycle: { ownsLease: () => true,
        record: async (kind: string, count: number) => { journal.push(`${kind}:${count}`); } } },
    } as DurableStart['input'],
    runtimeLaunch: { kind: 'pi-durable', credentialSource: 'keys-profile', binding, env: {}, release,
      declaration: binding.identity, decision: { kind: 'unconfigured', reason: 'resolver_unconfigured' },
      descendantPlan: null, sessionCwd: home },
    replicaRoot: path.join(root, 'replica'),
    launcher: { command: 'inert-test-launcher', profileDbPath: path.join(root, 'unused-profiles'), sessionDir: path.join(root, 'unused-sessions') },
    launcherArgs: [],
    spawnFn: ((_command: string, _args?: readonly string[], options?: SpawnOptions) => {
      const child = spawn(process.execPath, [path.join(import.meta.dirname, 'fixtures/fix-pi-durable-recovery-worker.mjs'), root, String(children.length)], options ?? {});
      children.push(child);
      return child;
    }) as typeof spawn,
  });
  sessions.push(session);
  const events: AgentEvent[] = [];
  let failure: unknown;
  const collect = async () => {
    try { for await (const event of session.events) events.push(event); }
    catch (error) { failure = error; }
  };
  return { root, session, journal, children, events, release, collect, failure: () => failure,
    starts: async () => (await readFile(path.join(root, 'starts.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)),
    modelCalls: async () => (await readFile(path.join(root, 'model-calls'), 'utf8')).trim().split('\n'),
  };
}
function assertFailed(f: Awaited<ReturnType<typeof fixture>>) {
  expect(f.failure()).toMatchObject({ phase: 'run', category: 'authority', retry: 'non-retryable' });
  expect(f.events.filter(event => event.type === 'error')).toHaveLength(1);
  expect(f.events.filter(event => event.type === 'turn_end')).toHaveLength(0);
  expect(() => f.session.resultDocument!()).toThrow('not terminal');
}

// Durable admission is POSIX-only; native Windows ownership is outside this test.
describe.skipIf(process.platform === 'win32')('F16-1 durable result redelivery across worker generations', () => {
  it.each(['saved', 'reordered'] as const)('recovers a %s document after death between result and completion', async result => {
    const f = await fixture([{ crash: true }, { result, complete: true }]);
    await f.collect();
    expect(f.failure()).toBeUndefined();
    expect(f.events).toEqual([
      { type: 'artifact', name: 'byok.result', contentType: 'application/json' },
      { type: 'turn_end' },
    ]);
    expect(f.session.resultDocument!()).toEqual(expectedDocument);
    expect(Object.keys(f.session.resultDocument!() as object)).toEqual(['text', 'detail']);
    expect(f.journal).toEqual(['respawn-intent:1']);
    expect(f.children).toHaveLength(2);
    expect((await f.starts()).map(command => ({ resume: command.resume, projectionDigest: command.projectionDigest }))).toEqual([
      { resume: false }, { resume: true, projectionDigest: 'a'.repeat(64) },
    ]);
    expect(await f.modelCalls()).toEqual(['synthetic-model-call']);
    await f.session.close();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.children.every(child => child.exitCode !== null || child.signalCode !== null)).toBe(true);
  });

  it.each([false, true])('accepts the first result normally (crashed before result: %s)', async crashed => {
    const f = await fixture([...(crashed ? [{ result: 'none' as const, crash: true }] : []), { complete: true }]);
    await f.collect();
    expect(f.failure()).toBeUndefined();
    expect(f.events.map(event => event.type)).toEqual(['artifact', 'turn_end']);
    expect(f.session.resultDocument!()).toEqual(expectedDocument);
    expect(f.children).toHaveLength(crashed ? 2 : 1);
    expect(await f.modelCalls()).toHaveLength(1);
  });

  it('accepts the same result through both permitted crash recoveries', async () => {
    const f = await fixture([{ crash: true }, { crash: true }, { complete: true }]);
    await f.collect();
    expect(f.failure()).toBeUndefined();
    expect(f.events.map(event => event.type)).toEqual(['artifact', 'turn_end']);
    expect(f.session.resultDocument!()).toEqual(expectedDocument);
    expect(f.journal).toEqual(['respawn-intent:1', 'respawn-intent:2']);
    expect(await f.modelCalls()).toHaveLength(1);
  });

  it.each(['conflict', 'nested-conflict', 'invalid'] as const)('rejects a recovered %s result without exposing a terminal document', async result => {
    const f = await fixture([{ crash: true }, { result, complete: true }]);
    await f.collect();
    assertFailed(f);
    expect(f.events.filter(event => event.type === 'artifact')).toHaveLength(1);
    expect(f.children).toHaveLength(2);
    expect(await f.modelCalls()).toHaveLength(1);
  });

  it.each([false, true])('rejects repeated result frames within one generation (recovered: %s)', async recovered => {
    const f = await fixture([...(recovered ? [{ crash: true }] : []), { duplicate: true, complete: true }]);
    await f.collect();
    assertFailed(f);
    expect(f.events.filter(event => event.type === 'artifact')).toHaveLength(1);
    expect(f.children).toHaveLength(recovered ? 2 : 1);
  });

  it('still requires completion and fails once the two respawns are exhausted', async () => {
    const f = await fixture([{ crash: true }, { crash: true }, { crash: true }]);
    await f.collect();
    assertFailed(f);
    expect(f.events.map(event => event.type)).toEqual(['artifact', 'error']);
    expect(f.journal).toEqual(['respawn-intent:1', 'respawn-intent:2']);
    expect(f.children).toHaveLength(3);
    expect(await f.modelCalls()).toHaveLength(1);
  });

  it('still rejects completion without any result', async () => {
    const f = await fixture([{ result: 'none', complete: true }]);
    await f.collect();
    assertFailed(f);
    expect(f.events.map(event => event.type)).toEqual(['error']);
    expect(f.journal).toEqual([]);
  });

  it('still refuses a changed provider projection before accepting redelivery', async () => {
    const f = await fixture([{ crash: true }, { complete: true, projectionDigest: 'b'.repeat(64) }]);
    await f.collect();
    assertFailed(f);
    expect(f.events.map(event => event.type)).toEqual(['artifact', 'error']);
    expect(f.children).toHaveLength(2);
  });
});
