import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { HostLedger } from '../../execution-core/ledger';
import { hash } from '../../execution-core/model';

interface Message { kind: string; dedupKey?: string; delivery?: number }
const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;
function launch(root: string, mode: 'crash' | 'run') {
  const messages: Message[] = [];
  const child = fork(fileURLToPath(new URL('./fixtures/hook-crash-host.ts', import.meta.url)), [root, mode], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout?.on('data', chunk => { output += String(chunk); });
  child.stderr?.on('data', chunk => { output += String(chunk); });
  child.on('message', message => { messages.push(message as Message); });
  return { child, messages, async message(kind: string): Promise<Message> {
    await vi.waitFor(() => {
      if (exited(child)) throw new Error(`Host exited: ${output}`);
      expect(messages.find(row => row.kind === 'error'), output).toBeUndefined();
      expect(messages.some(row => row.kind === kind), output).toBe(true);
    }, { timeout: 10_000 });
    return messages.find(row => row.kind === kind)!;
  } };
}
async function kill(child: ChildProcess): Promise<void> {
  if (exited(child)) return;
  const done = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGKILL'); await done;
}

it('commits an occurrence hook with its occurrence: a crash in the hook keeps neither, and redelivery keeps both once', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hc-hook-kill-'));
  const calls = async () => (await readFile(path.join(root, 'hook-calls.log'), 'utf8')).trim().split('\n');
  let host = launch(root, 'crash');
  let ledger: HostLedger | undefined;
  try {
    await host.message('ready');
    host.child.send({ kind: 'routine' });
    // The hook kills its own process inside the occurrence commit.
    await vi.waitFor(() => expect(exited(host.child)).toBe(true), { timeout: 10_000 });
    expect(host.messages.map(row => row.kind)).not.toContain('consumed');
    const [key] = await calls();
    expect(await calls()).toEqual([key]);
    ledger = new HostLedger(path.join(root, 'host.sqlite'), 'product:k4-hook-crash-test');
    const crashed = ledger.snapshot();
    expect(crashed.occurrences).toEqual({});
    expect(crashed.slots).toEqual({});
    expect(crashed.application).toEqual({});
    const wakeKey = Object.values(crashed.routines)[0]!.next!.dedupKey;
    expect(wakeKey).toMatch(/^hook-routine:1:\d+$/);

    host = launch(root, 'run');
    await host.message('ready');
    expect(await host.message('consumed')).toMatchObject({ dedupKey: wakeKey, delivery: 2 });
    // The hook ran again for the same occurrence. The ledger holds that occurrence and its Host state once.
    expect(await calls()).toEqual([key, key]);
    const recovered = ledger.snapshot();
    expect(Object.keys(recovered.occurrences)).toEqual([key]);
    expect(recovered.occurrences[key!]).toMatchObject({ wakeKey, hook: {} });
    expect(recovered.slots).toEqual({ [hash(wakeKey)]: key });
    expect(recovered.application).toEqual({ [key!]: { plannedAt: recovered.occurrences[key!]!.trigger.plannedAt } });
  } finally {
    await kill(host.child); ledger?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
