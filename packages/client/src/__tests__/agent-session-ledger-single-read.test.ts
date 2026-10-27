import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentSessionHandoffCorruptError, AgentSessionHandoffStore } from '../daemon/agent-session-handoff-store';
import { testScratchRoot } from './fixtures/execution-scratch';

afterEach(() => vi.restoreAllMocks());
async function fixture() {
  const home = testScratchRoot();
  const store = new AgentSessionHandoffStore();
  const input = {
    agentRef: { agentId: 'agent', profileRevision: '1' }, taskId: 'reader',
    sessionRef: 'session', runtimeId: 'test', home,
    cwd: path.join(home, '.byok/runs/reader'), homeAccess: 'memory-reader' as const, leaseId: 'lease',
  };
  const first = await store.record(input);
  const directory = path.join(home, '.byok/runtime-sessions');
  const file = path.join(directory, (await fs.readdir(directory))[0]!);
  return { home, store, input, first, file, directory };
}

it('reads each real session ledger once and uses the latest validated append for references and history', async () => {
  const f = await fixture();
  const latest = await f.store.recordTerminal(f.input, 'complete');
  await fs.appendFile(f.file, '\n');
  const read = vi.spyOn(fs, 'readFile');
  const references = await f.store.readerRunReferences(f.home);
  expect(read.mock.calls.filter(([file]) => file === f.file)).toHaveLength(1);
  expect([...references]).toEqual([[f.input.cwd, Date.parse(latest.updatedAt)]]);
  expect(await f.store.get(f.input)).toEqual(latest);
  expect(await f.store.history(f.input)).toEqual([f.first, latest]);
});

it.each(['{broken', JSON.stringify({ version: 2 }), JSON.stringify({ version: 1, agentRef: {} })])(
  'both scan and ordinary history reject a corrupt appended record: %s', async line => {
    const f = await fixture();
    await fs.appendFile(f.file, `${line}\n`);
    await expect(f.store.readerRunReferences(f.home)).rejects.toBeInstanceOf(AgentSessionHandoffCorruptError);
    await expect(f.store.history(f.input)).rejects.toBeInstanceOf(AgentSessionHandoffCorruptError);
  },
);

it('keeps empty-ledger behavior and rejects malformed first-line JSON', async () => {
  const f = await fixture();
  await fs.writeFile(f.file, '\n\n');
  expect(await f.store.readerRunReferences(f.home)).toEqual(new Map());
  expect(await f.store.history(f.input)).toEqual([]);
  await fs.writeFile(f.file, '{broken\n');
  await expect(f.store.readerRunReferences(f.home)).rejects.toThrow('Agent session evidence is unreadable');
});

it('uses record kind rather than filename for terminal evidence and preserves terminal validation', async () => {
  const f = await fixture();
  const terminal = await f.store.recordTaskTerminal({ ...f.input, taskId: 'failed-reader', terminalReason: 'startup failed' });
  const terminalFile = (await fs.readdir(f.directory)).find(name => path.join(f.directory, name) !== f.file)!;
  // A task-terminal record never becomes a session reference even in a session-looking filename.
  await fs.writeFile(f.file, await fs.readFile(path.join(f.directory, terminalFile)));
  const read = vi.spyOn(fs, 'readFile');
  expect(await f.store.readerRunReferences(f.home)).toEqual(new Map());
  expect(read.mock.calls.filter(([file]) => file === f.file)).toHaveLength(1);
  expect(await f.store.getTaskTerminal({ ...f.input, taskId: 'failed-reader' })).toEqual(terminal);
  await fs.appendFile(path.join(f.directory, terminalFile), JSON.stringify({ version: 1, kind: 'task-terminal' }) + '\n');
  await expect(f.store.getTaskTerminal({ ...f.input, taskId: 'failed-reader' })).rejects.toBeInstanceOf(AgentSessionHandoffCorruptError);
});
