import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentSessionHandoffStore,
  AgentSessionHandoffStoreError,
} from '../daemon/agent-session-handoff-store';

const roots: string[] = [];
const handles = new Set<fs.FileHandle>();
const POSIX = process.platform !== 'win32';
type Phase = 'ledger' | 'runtime-sessions' | '.byok' | 'home';
type Operation = 'open' | 'sync' | 'close';
const chain: Phase[] = POSIX ? ['ledger', 'runtime-sessions', '.byok', 'home'] : ['ledger'];

afterEach(async () => {
  expect(handles.size).toBe(0);
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-14-4-recovery-'));
  roots.push(root);
  const home = await fs.realpath(root);
  const internal = path.join(home, '.byok');
  const directory = path.join(internal, 'runtime-sessions');
  const events: Array<{ phase: Phase; operation: Operation }> = [];
  const opened: string[] = [];
  let fault: { phase: Phase; operation: Operation } | undefined;
  const open = fs.open.bind(fs);
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const file = String(args[0]); opened.push(file);
    const phase: Phase | undefined = file === home ? 'home' : file === internal ? '.byok'
      : file === directory ? 'runtime-sessions' : path.dirname(file) === directory && file.endsWith('.jsonl') ? 'ledger' : undefined;
    if (phase) {
      events.push({ phase, operation: 'open' });
      if (fault?.phase === phase && fault.operation === 'open') throw new Error(`injected ${phase} open EIO`);
    }
    const handle = await open(...args);
    if (phase) {
      handles.add(handle);
      const sync = handle.sync.bind(handle);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, 'sync').mockImplementation(async () => {
        events.push({ phase, operation: 'sync' });
        if (fault?.phase === phase && fault.operation === 'sync') throw new Error(`injected ${phase} sync EIO`);
        await sync();
      });
      vi.spyOn(handle, 'close').mockImplementation(async () => {
        await close(); handles.delete(handle); events.push({ phase, operation: 'close' });
        if (fault?.phase === phase && fault.operation === 'close') throw new Error(`injected ${phase} close EIO`);
      });
    }
    return handle;
  });
  const input = { agentRef: { agentId: 'handoff-agent', profileRevision: '7' }, taskId: 'task-1',
    sessionRef: 'runtime-session-1', runtimeId: 'pi', cwd: home, leaseId: 'lease-1' };
  return { home, directory, input, events, opened, setFault(value: typeof fault) { fault = value; } };
}

function assertCompleteBarrier(events: Awaited<ReturnType<typeof fixture>>['events']) {
  expect(events).toEqual(chain.flatMap(phase => (['open', 'sync', 'close'] as const).map(operation => ({ phase, operation }))));
}

describe('new 14-4 candidate: durable handoff directory publication', () => {
  it('flushes a fresh ledger through the supplied home before returning, and repeats on append', async () => {
    const h = await fixture(); const store = new AgentSessionHandoffStore();
    await expect(store.record(h.input)).resolves.toMatchObject(h.input);
    assertCompleteBarrier(h.events);
    h.events.length = 0;
    await expect(store.record(h.input)).resolves.toMatchObject(h.input);
    assertCompleteBarrier(h.events);
    expect(await store.history(h.input)).toHaveLength(2);
  });

  describe.skipIf(!POSIX)('POSIX directory barrier faults', () => {
    for (const phase of ['runtime-sessions', '.byok', 'home'] as const) {
      it.each(['record', 'terminal', 'task-terminal'] as const)(`refuses %s completion until ${phase} sync recovers, including existing-directory retry`, async kind => {
        const h = await fixture(); const store = new AgentSessionHandoffStore();
        if (kind === 'terminal') await store.record(h.input);
        h.setFault({ phase, operation: 'sync' }); h.events.length = 0;
        let laterAttempt = false;
        const write = () => kind === 'record' ? store.record(h.input)
          : kind === 'terminal' ? store.recordTerminal(h.input, laterAttempt ? 'failed' : 'complete', laterAttempt ? 'later' : 'first')
          : store.recordTaskTerminal({ ...h.input, terminalReason: 'startup failed' });
        const completions: unknown[] = [];
        const publish = () => write().then(value => { completions.push(value); return value; });
        await expect(publish()).rejects.toBeInstanceOf(AgentSessionHandoffStoreError);
        expect(completions).toEqual([]); expect(handles.size).toBe(0);
        expect((await fs.readdir(h.directory)).some(name => name.endsWith('.jsonl'))).toBe(true);
        laterAttempt = true; h.events.length = 0;
        await expect(publish()).rejects.toThrow(`injected ${phase} sync EIO`);
        expect(completions).toEqual([]); expect(handles.size).toBe(0);
        expect(h.events.filter(event => event.operation === 'sync').map(event => event.phase))
          .toEqual(chain.slice(0, chain.indexOf(phase) + 1));
        h.setFault(undefined); h.events.length = 0;
        const result = await publish();
        assertCompleteBarrier(h.events);
        expect(completions).toHaveLength(1);
        expect(result).toMatchObject({ agentRef: h.input.agentRef, taskId: h.input.taskId, runtimeId: h.input.runtimeId,
          cwd: h.home, leaseId: h.input.leaseId, sessionRef: h.input.sessionRef });
        if (kind === 'terminal') expect(result).toMatchObject({ terminalCause: 'complete', terminalReason: 'first' });
        if (kind === 'task-terminal') expect(result).toMatchObject({ terminalCause: 'failed', terminalReason: 'startup failed' });
      });
    }

    it.each(['open', 'close'] as const)('surfaces a directory %s failure and retries with no descriptor leak', async operation => {
      const h = await fixture(); const store = new AgentSessionHandoffStore();
      h.setFault({ phase: '.byok', operation });
      await expect(store.record(h.input)).rejects.toThrow(`injected .byok ${operation} EIO`);
      expect(handles.size).toBe(0);
      h.setFault(undefined); h.events.length = 0;
      await store.record(h.input); assertCompleteBarrier(h.events);
    });

    it('uses the real canonical home for a supplied alias and stops at that home', async () => {
      const h = await fixture(); const alias = `${h.home}-alias`; roots.push(alias);
      await fs.symlink(h.home, alias);
      await new AgentSessionHandoffStore().record({ ...h.input, cwd: alias });
      assertCompleteBarrier(h.events);
      expect(h.opened).toContain(h.home);
      expect(h.opened).not.toContain(path.dirname(h.home));
      expect(h.opened).not.toContain(alias);
    });
  });
});
