import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { admitReplica, acquireReplicaLock, resetReplica } from '../adapters/pi-durable/replica';
import { durableToolEnvironment } from '../adapters/pi-durable/environment';
import { projectDurableEvent } from '../adapters/pi-durable/events';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'byok-durable-core-')); roots.push(root);
  const home = path.join(root, 'home'); await mkdir(home);
  return { root, home, binding: { agentRef: { tenantId: 't', agentId: 'a', profileRevision: 'r' }, taskId: 'task-a', leaseId: 'lease-a', canonicalHome: home } };
}
describe('durable replica and tool boundaries', () => {
  it('rejects overlapping replica roots before creating files in the canonical home', async () => {
    const { home, binding } = await setup();
    await expect(admitReplica(path.join(home, 'durable'), binding)).rejects.toThrow('overlaps');
    await expect(readFile(path.join(home, 'durable'))).rejects.toThrow();
  });
  it('rejects a symlink alias without touching the target', async () => {
    const { root, home, binding } = await setup(); const alias = path.join(root, 'alias'); await symlink(home, alias, 'junction');
    await expect(admitReplica(alias, binding)).rejects.toThrow('symlink');
  });
  it('isolates task identity and clears stale replica state before opening on a new execution', async () => {
    const { root, binding } = await setup(); const store = path.join(root, 'durable');
    const first = await admitReplica(store, binding), second = await admitReplica(store, { ...binding, taskId: 'task-b' });
    expect(first).not.toBe(second);
    await writeFile(first, 'untrusted pending state'); const lock = await acquireReplicaLock(first, binding.leaseId);
    try { await resetReplica(first); await expect(readFile(first)).rejects.toThrow(); }
    finally { lock.release(); }
  });
  it('holds its OS-backed sidecar lock after commit and releases on close', async () => {
    const { root, binding } = await setup(); const file = await admitReplica(path.join(root, 'durable'), binding);
    const first = await acquireReplicaLock(file, 'lease-a');
    await expect(acquireReplicaLock(file, 'lease-b')).rejects.toThrow('locked');
    first.release(); const second = await acquireReplicaLock(file, 'lease-b'); second.release();
  });
  it('real cross-process OS lock refuses overlap and becomes available only after KILL close receipt', async () => {
    const { root, binding } = await setup(); const file = await admitReplica(path.join(root, 'durable'), binding);
    const code = "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1]); db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE owner(slot INTEGER PRIMARY KEY,lease_id TEXT); BEGIN EXCLUSIVE;'); db.prepare('INSERT INTO owner VALUES(1,?)').run('old-lease'); db.exec('COMMIT'); console.log('locked'); setInterval(()=>{},1000);";
    const child = spawn(process.execPath, ['-e', code, `${file}.lock.sqlite`], { stdio: ['ignore','pipe','pipe'] });
    try {
      await new Promise<void>((resolve,reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject); child.once('exit', () => reject(new Error('lock fixture exited'))); });
      await expect(acquireReplicaLock(file, 'current-lease')).rejects.toThrow('locked');
      child.kill('SIGKILL'); await once(child, 'close');
      const current = await acquireReplicaLock(file, 'current-lease'); current.release();
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child,'close'); } }
  });
  it('provider credentials are absent even when a tool requests inherited env', async () => {
    const { home } = await setup();
    const previous = { pi: process.env.PI_PROVIDER_API_KEY, openai: process.env.OPENAI_API_KEY };
    process.env.PI_PROVIDER_API_KEY = process.env.OPENAI_API_KEY = 'PROVIDER_SECRET_SENTINEL';
    const env = durableToolEnvironment(home, process.env);
    try {
      const probe = path.join(home, 'environment-probe.mjs');
      await writeFile(probe, "console.log(JSON.stringify({PI_PROVIDER_API_KEY:process.env.PI_PROVIDER_API_KEY,OPENAI_API_KEY:process.env.OPENAI_API_KEY}))");
      let output = '';
      const quote = (value: string) => JSON.stringify(value.replaceAll('\\', '/'));
      const result = await env.exec(`${quote(process.execPath)} ${quote(probe)}`, { inheritEnv: true,
        env: { PI_PROVIDER_API_KEY: 'PROVIDER_SECRET_SENTINEL' }, onOutput: text => { output += text; } }, BACKGROUND_CONTEXT);
      expect(result.ok).toBe(true);
      if (!result.ok) throw result.error;
      expect(result.value.exitCode).toBe(0);
      expect(JSON.parse(output.trim())).toEqual({});
    } finally {
      for (const [key, value] of [['PI_PROVIDER_API_KEY', previous.pi], ['OPENAI_API_KEY', previous.openai]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await env.cleanup(BACKGROUND_CONTEXT);
    }
  });
  it('discards snapshots, partial usage and model turn boundaries; run_end alone completes', () => {
    expect(projectDurableEvent({ type: 'turn_end' })).toEqual([]);
    expect(projectDurableEvent({ type: 'message_update', usage: {} as never, changes: [{ type: 'text_delta', contentIndex: 0, delta: 'ok' }] })).toEqual([{ type: 'progress', text: 'ok' }]);
    expect(projectDurableEvent({ type: 'run_end', inputs: [] })).toEqual([{ type: 'turn_end' }]);
    expect(projectDurableEvent({ type: 'tool_execution_end', toolCallId: 'id', toolName: 'bash' })).toMatchObject([{ type: 'tool_result', isError: true }]);
  });
});
