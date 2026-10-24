import { testExecutionScratch } from './fixtures/execution-scratch';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { AgentEvent } from '@byok-sdk/protocol';
import { startDurablePi, type DurableStart } from '../adapters/pi-durable/session';
import type { Session, MessageDraftDelta } from '../types';

interface WorkerPlan {
  complete?: boolean;
  crash?: boolean;
  retiredResultFrame?: boolean;
  projectionDigest?: string;
}
const roots: string[] = [];
const sessions: Session[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture(plan: WorkerPlan[]) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'fix-pi-durable-recovery-')));
  roots.push(root);
  const home = path.join(root, 'home');
  await mkdir(home);
  await writeFile(path.join(root, 'plan.json'), JSON.stringify(plan));
  const journal: string[] = [];
  const children: ChildProcess[] = [];
  const scratch = await testExecutionScratch();
  const release = vi.fn(() => scratch.release());
  // The injected spawn launches only our inert fixture, never Pi.
  const session = await startDurablePi({
    input: { scratch,
      instruction: 'synthetic instruction', mcpEnv: {},
      manifest: { taskId: 'task', cwd: home,
        agentRef: { agentId: 'agent', profileRevision: 'revision' },
        lease: { leaseId: 'lease', canonicalHome: home },
        dispatchSelection: { lane: 'byok', runtimeId: 'pi', providerId: 'probe', modelId: 'test' } },
      durableContext: { tenantId: 'tenant', lifecycle: { ownsLease: () => true,
        record: async (kind: string, count: number) => { journal.push(`${kind}:${count}`); } } },
    } as DurableStart['input'],
    runtimeLaunch: { scratch, kind: 'pi-durable', credentialSource: 'keys-profile', command: process.execPath, fixedArgs: [], cwd: root,
      projectionDir: path.join(root, 'projection'), env: {}, release, sessionCwd: home },
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
  const events: Array<AgentEvent | MessageDraftDelta> = [];
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
  expect(f.events.filter(event => event.type === 'artifact')).toHaveLength(0);
}

// Durable admission is POSIX-only; native Windows ownership is outside this test.
// Wire v3: completion is the worker's durable_complete alone. A result-document
// outcome is staged by the daemon through submit_result, so no generation
// carries or redelivers a document and the Session exposes none.
describe.skipIf(process.platform === 'win32')('F16-1 durable completion across worker generations', () => {
  it('recovers a completion after death before it, without a second model call', async () => {
    const f = await fixture([{ crash: true }, { complete: true }]);
    await f.collect();
    expect(f.failure()).toBeUndefined();
    expect(f.events).toEqual([{ type: 'turn_end' }]);
    expect(f.session).not.toHaveProperty('resultDocument');
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

  it('completes in the first generation', async () => {
    const f = await fixture([{ complete: true }]);
    await f.collect();
    expect(f.failure()).toBeUndefined();
    expect(f.events.map(event => event.type)).toEqual(['turn_end']);
    expect(f.children).toHaveLength(1);
    expect(await f.modelCalls()).toHaveLength(1);
  });

  it('completes through both permitted crash recoveries', async () => {
    const f = await fixture([{ crash: true }, { crash: true }, { complete: true }]);
    await f.collect();
    expect(f.failure()).toBeUndefined();
    expect(f.events.map(event => event.type)).toEqual(['turn_end']);
    expect(f.journal).toEqual(['respawn-intent:1', 'respawn-intent:2']);
    expect(await f.modelCalls()).toHaveLength(1);
  });

  it.each([false, true])('refuses the retired durable_result frame (recovered: %s)', async recovered => {
    const f = await fixture([...(recovered ? [{ crash: true }] : []), { retiredResultFrame: true, complete: true }]);
    await f.collect();
    assertFailed(f);
    expect(f.children).toHaveLength(recovered ? 2 : 1);
  });

  it('fails once the two respawns are exhausted', async () => {
    const f = await fixture([{ crash: true }, { crash: true }, { crash: true }]);
    await f.collect();
    assertFailed(f);
    expect(f.events.map(event => event.type)).toEqual(['error']);
    expect(f.journal).toEqual(['respawn-intent:1', 'respawn-intent:2']);
    expect(f.children).toHaveLength(3);
    expect(await f.modelCalls()).toHaveLength(1);
  });

  it('still refuses a changed provider projection on recovery', async () => {
    const f = await fixture([{ crash: true }, { complete: true, projectionDigest: 'b'.repeat(64) }]);
    await f.collect();
    assertFailed(f);
    expect(f.events.map(event => event.type)).toEqual(['error']);
    expect(f.children).toHaveLength(2);
  });
});
