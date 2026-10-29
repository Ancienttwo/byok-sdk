import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemonWithAdapters } from '@byok-sdk/client';
import { expect, it, vi } from 'vitest';
import { InMemoryDeviceCredentialStore } from '../../../scripts/testing/device-credentials.mjs';
import { BotStubAdapter, waitForReady } from '../../basic/goal-btw.test-support';
import type { ByokServer } from '@byok-sdk/server';
import { HostLedger } from '@byok-sdk/server/execution-core';
import { policy, template } from './test-support';

type Attempt = NonNullable<Awaited<ReturnType<ByokServer['tasks']['attempt']>>>;
interface Message {
  kind: string; port: number; code: string; taskId: string; delivering: boolean;
  dedupKey: string; delivery: number; beforeReplayCount: number; slotReplayCount: number;
  sdkWake?: { dedupKey: string; state: string; deliveries: number };
  attempt?: Attempt;
}
function launch(root: string, port: number, hold: boolean) {
  const messages: Message[] = [];
  const child = fork(fileURLToPath(new URL('./fixtures/crash-host.ts', import.meta.url)), [root, String(port), hold ? 'hold' : 'run'], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout?.on('data', chunk => { output += String(chunk); });
  child.stderr?.on('data', chunk => { output += String(chunk); });
  child.on('message', message => { messages.push(message as Message); });
  return { child, async message(kind: string): Promise<Message> {
    await vi.waitFor(() => {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Host exited: ${output}`);
      expect(messages.find(row => row.kind === 'error')).toBeUndefined();
      expect(messages.some(row => row.kind === kind), output).toBe(true);
    }, { timeout: 10_000 });
    return messages.find(row => row.kind === kind)!;
  } };
}
async function kill(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  child.kill('SIGKILL'); await exited;
}

it('SIGKILL during wake delivery recovers the frozen input and only one execution', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'hc-kill-'));
  let processHost = launch(root, 0, true);
  let daemon: ReturnType<typeof createDaemonWithAdapters> | undefined;
  let ledger: HostLedger | undefined;
  try {
    const ready = await processHost.message('ready');
    const adapter = new BotStubAdapter();
    daemon = createDaemonWithAdapters({ productId: 'k4-crash-test', productName: 'Crash test',
      localAgentRelease: { version: '0.0.0-test' }, serverUrl: `http://127.0.0.1:${ready.port}`,
      storeDir: path.join(root, 'sdk'),
      agentHome: { hostStorageRoot: path.join(root, 'homes') }, agentEgress: { policy },
    }, [adapter], { deviceCredentials: new InMemoryDeviceCredentialStore() });
    const { deviceId } = await daemon.pair(ready.code);
    await daemon.start(); await waitForReady(daemon);
    processHost.child.send({ kind: 'routine', execution: template(deviceId) });
    const submitted = await processHost.message('submitted');
    expect(submitted.delivering).toBe(true);
    expect(submitted.delivery).toBe(1);
    await vi.waitFor(() => expect(adapter.sessions.has(submitted.taskId)).toBe(true));
    await kill(processHost.child);

    ledger = new HostLedger(path.join(root, 'host.sqlite'), 'product:k4-crash-test');
    const before = ledger.snapshot();
    expect(Object.keys(before.occurrences)).toHaveLength(1);
    expect(Object.values(before.occurrences)[0]!.wakeKey).toBe(submitted.dedupKey);
    expect(before.executions[submitted.taskId]?.submission).toBe('uncertain');
    expect(Object.values(before.outbox).some(row => row.kind === 'intent')).toBe(true);

    processHost = launch(root, ready.port, false);
    await processHost.message('ready');
    const replayed = await processHost.message('replayed');
    expect(replayed).toMatchObject({ dedupKey: submitted.dedupKey, taskId: submitted.taskId,
      delivery: 2, beforeReplayCount: 0, slotReplayCount: 1 });
    expect(replayed.sdkWake).toMatchObject({ dedupKey: submitted.dedupKey, state: 'delivering', deliveries: 2 });
    expect(replayed.attempt).toMatchObject({ taskId: submitted.taskId, deviceId, status: 'running', claimedRuntime: 'pi' });
    adapter.sessions.get(submitted.taskId)!.finish({ text: 'survived Host death' });
    await vi.waitFor(() => expect(Object.values(ledger!.snapshot().intents)[0]?.conclusion).toBe('succeeded'), { timeout: 15_000 });
    const after = ledger.snapshot();
    expect(Object.keys(after.occurrences)).toEqual(Object.keys(before.occurrences));
    expect(Object.values(after.occurrences)[0]!.slotReplayCount).toBe(1);
    expect(Object.keys(after.executions)).toEqual([submitted.taskId]);
    expect(after.executions[submitted.taskId]?.input).toEqual(before.executions[submitted.taskId]?.input);
    expect(Object.keys(after.applied)).toEqual([submitted.taskId]);
    expect(adapter.starts.map(start => start.manifest.taskId)).toEqual([submitted.taskId]);
  } finally {
    await daemon?.stop();
    await kill(processHost.child); ledger?.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
