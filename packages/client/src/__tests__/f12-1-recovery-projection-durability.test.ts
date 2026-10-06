import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_HOME_PROJECTION_STATE_FILE,
  AgentHomeBusyError,
  AgentHomeManager,
  createAgentHomeProjectionConsumer,
} from '../agent-home';
import * as mutationGate from '../daemon/path-mutation-gate';

const originalGate = mutationGate.acquirePathMutationGate;
const roots: string[] = [];
const heldGates = new Set<string>();
const HASH = `sha256:${'a'.repeat(64)}`;
const OTHER_HASH = `sha256:${'b'.repeat(64)}`;
const FIRST = '00000000-0000-4000-8000-000000000001';
const RETRY = '00000000-0000-4000-8000-000000000002';

beforeEach(() => {
  // Only the kernel path-mutation gate is replaced. Home resolution, writer
  // marker ownership, atomic rename and all file/directory syncs remain real.
  vi.spyOn(mutationGate, 'acquirePathMutationGate').mockImplementation(async input => {
    const targetPath = await mutationGate.resolvePathWithoutCreate(input.targetPath);
    const identity = `${input.scope}:${targetPath}`;
    if (heldGates.has(identity)) throw new mutationGate.PathMutationGateBusyError(input.scope, targetPath);
    heldGates.add(identity);
    let released = false;
    return { scope: input.scope, targetPath, identity, async release() {
      if (!released) { released = true; heldGates.delete(identity); }
    } };
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => { throw new Error('unexpected network access'); });
});

afterEach(async () => {
  expect(heldGates.size).toBe(0);
  expect(globalThis.fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  expect(mutationGate.acquirePathMutationGate).toBe(originalGate);
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function desired(revision = '7', projectionHash = HASH, requestId = FIRST) {
  return { requestId, agentRef: { agentId: 'durability-agent', profileRevision: revision }, projectionHash,
    projection: { name: `Profile ${revision}` } };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-f12-recovery-'));
  roots.push(root);
  const home = path.join(await fs.realpath(root), 'agents', 'durability-agent');
  const state = path.join(home, '.byok', AGENT_HOME_PROJECTION_STATE_FILE);
  const events: string[] = [];
  let fail: 'target' | 'directory' | undefined;
  let failHook = false;
  let durable: string | undefined;
  const open = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args);
    const file = String(args[0]);
    const phase = file === state ? 'target' : file === path.dirname(state) ? 'directory' : undefined;
    if (phase) {
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        events.push(phase);
        if (fail === phase) throw Object.assign(new Error(`injected ${phase} fsync EIO`), { code: 'EIO' });
        await sync();
        if (phase === 'directory' || (phase === 'target' && process.platform === 'win32')) {
          durable = await fs.readFile(state, 'utf8');
        }
      });
    }
    return handle;
  });
  const apply = vi.fn(async ({ cwd, projection }: { cwd: string; projection: unknown }) => {
    events.push('hook');
    if (failHook) throw new Error('host hook failed');
    await fs.writeFile(path.join(cwd, 'profile.json'), JSON.stringify(projection));
  });
  const manager = () => new AgentHomeManager({ hostStorageRoot: root, projection: createAgentHomeProjectionConsumer(apply) });
  return { home, state, events, apply, manager,
    setFault(value: typeof fail) { fail = value; },
    setHookFault(value: boolean) { failHook = value; },
    checkpoint() { return durable; },
  };
}

const stages = process.platform === 'win32' ? ['target'] as const : ['target', 'directory'] as const;

describe('new F12.1 candidate: ordering-state durability before acknowledgement', () => {
  for (const stage of stages) {
    it.each(['idempotent', 'stale', 'conflict'] as const)(`retries a visible ${stage}-sync failure before %s acknowledgement`, async outcome => {
      const h = await fixture();
      h.setFault(stage);
      await expect(h.manager().project(desired())).rejects.toThrow(`injected ${stage} fsync EIO`);
      const visible = await fs.readFile(h.state, 'utf8');
      expect(JSON.parse(visible)).toMatchObject({ requestId: FIRST, agentRef: { profileRevision: '7' }, projectionHash: HASH });
      expect(h.checkpoint()).toBeUndefined();
      const replay = desired(outcome === 'stale' ? '6' : '7', outcome === 'conflict' ? OTHER_HASH : HASH, RETRY);
      const completions: string[] = [];
      const deliver = () => h.manager().project(replay).then(result => { completions.push(result); return result; });
      h.events.length = 0;
      await expect(deliver()).rejects.toThrow(`injected ${stage} fsync EIO`);
      expect(completions).toEqual([]);
      expect(h.events).toContain(stage);
      expect(await fs.readFile(h.state, 'utf8')).toBe(visible);
      h.setFault(undefined); h.events.length = 0;
      await expect(deliver()).resolves.toBe(outcome);
      expect(completions).toEqual([outcome]);
      expect(h.checkpoint()).toBe(visible);
      expect(await fs.readFile(h.state, 'utf8')).toBe(visible);
      const barrier = process.platform === 'win32' ? ['target'] : ['target', 'directory'];
      expect(h.events).toEqual(outcome === 'idempotent' ? ['hook', ...barrier] : barrier);
      expect(h.apply).toHaveBeenCalledTimes(outcome === 'idempotent' ? 3 : 1);
    });
  }

  it('does not establish a replay barrier or change identity if the host hook fails', async () => {
    const h = await fixture();
    await expect(h.manager().project(desired())).resolves.toBe('applied');
    const original = await fs.readFile(h.state, 'utf8');
    h.setHookFault(true); h.events.length = 0;
    await expect(h.manager().project(desired('7', HASH, RETRY))).rejects.toThrow('host hook failed');
    expect(h.events).toEqual(['hook']);
    expect(await fs.readFile(h.state, 'utf8')).toBe(original);
    h.setHookFault(false);
    await expect(h.manager().project(desired('7', HASH, RETRY))).resolves.toBe('idempotent');
    expect(await fs.readFile(h.state, 'utf8')).toBe(original);
  });

  it('reapplies after simulated loss of an unacknowledged rename and retains the repaired revision fence', async () => {
    const h = await fixture();
    await expect(h.manager().project(desired('6'))).resolves.toBe('applied');
    const oldDurable = h.checkpoint()!;
    h.setFault(process.platform === 'win32' ? 'target' : 'directory');
    await expect(h.manager().project(desired('7', HASH, RETRY))).rejects.toThrow('fsync EIO');
    await expect(h.manager().project(desired('7', HASH, RETRY))).rejects.toThrow('fsync EIO');
    expect(h.checkpoint()).toBe(oldDurable);
    // Test-only crash model: discard the unflushed rename, retaining the last
    // successfully flushed record. This is not a real power-loss experiment.
    await fs.writeFile(h.state, oldDurable);
    h.setFault(undefined);
    await expect(h.manager().project(desired('7', HASH, RETRY))).resolves.toBe('applied');
    const repaired = h.checkpoint()!;
    expect(JSON.parse(repaired)).toMatchObject({ requestId: RETRY, agentRef: { profileRevision: '7' } });
    await fs.writeFile(h.state, repaired);
    const calls = h.apply.mock.calls.length;
    await expect(h.manager().project(desired('6'))).resolves.toBe('stale');
    expect(h.apply).toHaveBeenCalledTimes(calls);
    expect(await fs.readFile(h.state, 'utf8')).toBe(repaired);
  });

  it('keeps the real home writer lease held across a paused replay hook and its barrier', async () => {
    const h = await fixture();
    await h.manager().project(desired());
    let resume!: () => void; let entered!: () => void;
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const began = new Promise<void>(resolve => { entered = resolve; });
    h.apply.mockImplementationOnce(async () => { entered(); await paused; });
    const replay = h.manager().project(desired('7', HASH, RETRY));
    await began;
    try { await expect(h.manager().project(desired('8'))).rejects.toBeInstanceOf(AgentHomeBusyError); }
    finally { resume(); }
    await expect(replay).resolves.toBe('idempotent');
    await expect(h.manager().project(desired('8'))).resolves.toBe('applied');
  });
});
