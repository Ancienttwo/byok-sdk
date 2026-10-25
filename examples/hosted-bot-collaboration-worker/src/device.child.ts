/**
 * One device as its own OS process: its own pairing (enrollment), SDK store dir, workspace and Agent home, and a synthetic
 * runtime (the K8 stub adapter). The test process drives it over the Node IPC channel:
 *
 * - `{ type: 'pair', serverUrl, code, root }` pairs, starts the daemon and answers `{ type: 'ready', deviceId }`;
 * - each new runtime session is reported as `{ type: 'started', taskId, agentId }`;
 * - `{ type: 'finish', taskId, document }` ends that session with the result document (the stub's `submit_result` call),
 *   answered by `{ type: 'finished', taskId }`;
 * - `{ type: 'stop' }` stops the daemon, then the process exits.
 *
 * Errors go back as `{ type: 'error', message }`. The machine identity is synthetic (a hash of the root), so two of these
 * on one computer are two devices to the SDK, not two computers.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { createAgentHomeProjectionConsumer, createDaemonWithAdapters, type Daemon } from '@byok-sdk/client';
import { policy } from '@byok-sdk/example-host-execution-core/test-support';
import { InMemoryDeviceCredentialStore } from '../../../scripts/testing/device-credentials.mjs';
import { BotStubAdapter } from '../../basic/goal-btw.test-support';

export type ParentMessage =
  | { type: 'pair'; serverUrl: string; code: string; root: string }
  | { type: 'finish'; taskId: string; document: unknown }
  | { type: 'stop' };
export type ChildMessage =
  | { type: 'ready'; deviceId: string }
  | { type: 'started'; taskId: string; agentId: string }
  | { type: 'finished'; taskId: string }
  | { type: 'error'; message: string };

const send = (message: ChildMessage) => { process.send?.(message); };
const adapter = new BotStubAdapter();
let daemon: Daemon | undefined;
const reported = new Set<string>();

async function pair(serverUrl: string, code: string, root: string): Promise<void> {
  daemon = createDaemonWithAdapters({ productId: 'hosted-collaboration-worker', productName: 'Hosted collaboration Worker',
    localAgentRelease: { version: '0.0.0-test' }, machineId: async () => createHash('sha256').update(root).digest('hex'), serverUrl,
    workspaceRoot: path.join(root, 'workspace'), storeDir: path.join(root, 'sdk'),
    // The H persona hook, as the H tests install it: the device applies a task-free projection and advertises it.
    agentHome: { hostStorageRoot: path.join(root, 'homes'), projection: createAgentHomeProjectionConsumer(async ({ projection, writeHomeFile }) => {
      await writeHomeFile('AGENTS.md', String((projection as { persona?: unknown }).persona ?? ''));
    }) },
    agentEgress: { policy },
  }, [adapter], { deviceCredentials: new InMemoryDeviceCredentialStore() });
  const { deviceId } = await daemon.pair(code);
  await daemon.start();
  // The client's own ready fact: the server accepted this run's `conn.hello`.
  for (const deadline = Date.now() + 30_000; ;) {
    const lifecycle = daemon.status().lifecycle;
    if (lifecycle.phase === 'running' && lifecycle.connection === 'open') break;
    if (Date.now() > deadline) throw new Error(`daemon never became ready: ${JSON.stringify(lifecycle)}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  send({ type: 'ready', deviceId });
}

// The stub adapter keeps its sessions in a map; report each new one once.
const watcher = setInterval(() => {
  for (const start of adapter.starts) {
    const taskId = start.manifest.taskId;
    if (reported.has(taskId)) continue;
    reported.add(taskId);
    send({ type: 'started', taskId, agentId: start.manifest.agentRef?.agentId ?? '' });
  }
}, 25);

process.on('message', (message: ParentMessage) => {
  void (async () => {
    if (message.type === 'pair') await pair(message.serverUrl, message.code, message.root);
    else if (message.type === 'finish') {
      const session = adapter.sessions.get(message.taskId);
      if (!session) throw new Error(`no runtime session for ${message.taskId}`);
      await session.finish(message.document);
      send({ type: 'finished', taskId: message.taskId });
    } else if (message.type === 'stop') {
      clearInterval(watcher);
      await daemon?.stop();
      process.exit(0);
    }
  })().catch(error => { send({ type: 'error', message: error instanceof Error ? error.stack ?? error.message : String(error) }); });
});
