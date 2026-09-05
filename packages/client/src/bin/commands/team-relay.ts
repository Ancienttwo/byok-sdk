import { TeamNotificationRelay } from '../team-notification-relay';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { DaemonConfig } from '../../daemon/create-daemon';
import { ensureSecureDir } from '../../util/secure-dir';
import { connectControlClient } from '../control-client';
import { resolveStoreDir } from '../config';
import { loadCodexTeamBindings, preflightCodexRelay, queueCodexTeamNotification } from '../team-codex-relay';

/** One foreground owner per room. Stale locks are never guessed away or stolen. */
export async function acquireTeamRelayLock(storeDir: string, workspaceId: string): Promise<() => Promise<void>> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(workspaceId)) throw new Error('invalid relay workspace id');
  const directory = path.join(storeDir, 'team-relay-locks');
  await ensureSecureDir(directory);
  const lock = path.join(directory, `${workspaceId}.lock`);
  try { await fs.mkdir(lock, { mode: 0o700 }); } catch { throw new Error('room relay lock unavailable; verify the prior owner before removing a stale lock'); }
  try { await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' }); }
  catch (error) { await fs.rmdir(lock); throw error; }
  return async () => { await fs.unlink(path.join(lock, 'owner.json')); await fs.rmdir(lock); };
}

export async function runTeamRelayCommand(input: {
  config: DaemonConfig; workspaceId: string; bindingsFile: string; codexBin: string; maxNotifications: number; signal: AbortSignal;
}): Promise<void> {
  if (!Number.isInteger(input.maxNotifications) || input.maxNotifications < 1 || input.maxNotifications > 100) throw new Error('max-notifications must be an integer from 1 to 100');
  const bindings = await loadCodexTeamBindings(input.bindingsFile, input.workspaceId);
  if (!path.isAbsolute(input.codexBin)) throw new Error('Codex executable must be absolute');
  const codexBin = await fs.realpath(input.codexBin);
  await fs.access(codexBin, fs.constants.X_OK);
  const codexVersion = await preflightCodexRelay(codexBin, input.signal);
  const connection = await connectControlClient({ storeDir: resolveStoreDir(input.config), productId: input.config.productId });
  if (!connection.ok) throw new Error(connection.reason);
  const client = connection.client;
  let release: (() => Promise<void>) | undefined;
  let commands: ReturnType<typeof createInterface> | undefined;
  const relay = new TeamNotificationRelay({ bindings, describe: binding => ({ threadId: binding.threadId }), maxNotifications: input.maxNotifications,
    snapshot: (binding, afterSeq) => client.request('team_notifications.snapshot', { context: binding.context, afterSeq }),
    enqueue: async (binding, throughSeq, signal) => {
      const status = relay.status();
      const event = { memberId: binding.lease.memberId, threadId: binding.threadId, attempt: status.attempts,
        watermark: status.bindings.find(item => item.memberId === binding.lease.memberId)!.notifiedThroughSeq, latestPeerSeq: throughSeq };
      process.stdout.write(`${JSON.stringify({ event: 'queue_attempt', ...event })}\n`);
      const queueId = await queueCodexTeamNotification({ codexBin, binding, throughSeq, signal });
      process.stdout.write(`${JSON.stringify({ event: 'queue_accepted', ...event, queueId })}\n`);
      return queueId;
    },
  });
  const print = () => process.stdout.write(`${JSON.stringify(relay.status())}\n`);
  const stop = () => relay.stop();
  input.signal.addEventListener('abort', stop, { once: true });
  try {
    release = await acquireTeamRelayLock(resolveStoreDir(input.config), input.workspaceId);
    if (input.signal.aborted) relay.stop();
    commands = createInterface({ input: process.stdin, terminal: false });
    commands.on('line', line => {
      if (line === 'pause') relay.pause();
      else if (line === 'resume') relay.resume();
      else if (line === 'stop') relay.stop();
      else if (line !== 'status') { process.stdout.write('{"error":"expected pause, resume, status or stop"}\n'); return; }
      print();
    });
    process.stdout.write(`${JSON.stringify({ event: 'preflight', codexBin, codexVersion })}\n`);
    print();
    while (['running', 'paused'].includes(relay.status().state)) {
      const before = JSON.stringify(relay.status());
      await relay.tick();
      if (before !== JSON.stringify(relay.status())) print();
      if (!['running', 'paused'].includes(relay.status().state)) break;
      await new Promise<void>(resolve => {
        const done = () => { clearTimeout(timer); input.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, 250);
        input.signal.addEventListener('abort', done, { once: true });
        if (input.signal.aborted) done();
      });
    }
    if (relay.status().state === 'failed') throw new Error(`team relay stopped: ${relay.status().error}`);
  } finally {
    relay.stop();
    input.signal.removeEventListener('abort', stop);
    commands?.close();
    client.close();
    await release?.();
  }
}
