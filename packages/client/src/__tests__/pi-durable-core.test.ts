import { afterEach, describe, expect, it } from 'vitest';
import { copyFile, mkdtemp, mkdir, readdir, rm, symlink, writeFile, readFile } from 'node:fs/promises';
import { copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readSqliteFileUnchanged } from '@byok-sdk/core/sqlite-node';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { admitReplica, acquireReplicaLock, replicaLockPath, resetReplica } from '../adapters/pi-durable/replica';
import { DurableReplicaFormatError, openLocalDurableStorage } from '../adapters/pi-durable/storage';
import { durableToolEnvironment } from '../adapters/pi-durable/environment';
import { DurableViewProjection, projectDurableEvent } from '../adapters/pi-durable/events';
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
  // A released 0.43.0 replica in rollback-journal mode; refusal must leave its bytes and directory as they were.
  const RELEASED_REPLICA = new URL('../../../../scripts/release/fixtures/stores/0.43.0/daemon-store/durable-replicas/fixture/durable-fixture.sqlite', import.meta.url);
  const sha256 = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex');
  it('refuses a lock path that holds another task replica without writing to it', async () => {
    const { root, binding } = await setup(); const file = await admitReplica(path.join(root, 'durable'), binding);
    const lockPath = replicaLockPath(file); await copyFile(RELEASED_REPLICA, lockPath);
    const before = await sha256(lockPath), entries = await readdir(path.dirname(lockPath));
    await expect(acquireReplicaLock(file, binding.leaseId)).rejects.toThrow('another database');
    expect(await sha256(lockPath)).toBe(before);
    expect(await readdir(path.dirname(lockPath))).toEqual(entries);
  });
  it('refuses a replica from an older pi-durable schema without migrating it', async () => {
    const { root, binding } = await setup(); const file = await admitReplica(path.join(root, 'durable'), binding);
    await copyFile(RELEASED_REPLICA, file);
    const fixture = new DatabaseSync(file); fixture.exec('UPDATE durable_schema SET version = version - 1'); fixture.close();
    const before = await sha256(file), entries = await readdir(path.dirname(file));
    await expect(openLocalDurableStorage(file)).rejects.toBeInstanceOf(DurableReplicaFormatError);
    expect(await sha256(file)).toBe(before);
    expect(await readdir(path.dirname(file))).toEqual(entries);
  });
  /** A copy of `source` whose schema and rows exist only in its WAL, as a replica that crashed before its first checkpoint leaves it. */
  async function walOnlyCopy(source: string, target: string, edit: string): Promise<void> {
    const original = `${target}.source`, scratch = `${target}.scratch`;
    await copyFile(source, original);
    const db = new DatabaseSync(scratch);
    try {
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; ATTACH '${original}' AS src;`);
      const objects = db.prepare("SELECT type, name, sql FROM src.sqlite_schema WHERE sql IS NOT NULL ORDER BY type = 'table' DESC").all() as Array<{ type: string; name: string; sql: string }>;
      for (const object of objects) db.exec(object.sql);
      for (const object of objects) if (object.type === 'table') db.exec(`INSERT INTO main."${object.name}" SELECT * FROM src."${object.name}"`);
      db.exec(`DETACH src; ${edit}`);
      copyFileSync(scratch, target); copyFileSync(`${scratch}-wal`, `${target}-wal`);
    } finally { db.close(); }
    for (const file of [original, scratch]) await rm(file);
    // The branch under test: the main file alone shows no schema, the WAL holds all of it.
    expect(readSqliteFileUnchanged(target, (main) => main.prepare('SELECT count(*) AS n FROM sqlite_schema').get())).toEqual({ n: 0 });
  }
  const replicaSource = () => new URL(RELEASED_REPLICA).pathname;
  it('refuses another task replica at the lock path whose schema is only in its WAL, without writing owner', async () => {
    const { root, binding } = await setup(); const file = await admitReplica(path.join(root, 'durable'), binding);
    const lockPath = replicaLockPath(file); await walOnlyCopy(replicaSource(), lockPath, '');
    await expect(acquireReplicaLock(file, binding.leaseId)).rejects.toThrow('another database');
    const db = new DatabaseSync(lockPath);
    try { expect(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'owner'").get()).toEqual({ n: 0 }); } finally { db.close(); }
  });
  it('refuses an older replica whose schema is only in its WAL before pi-durable opens it', async () => {
    const { root, binding } = await setup(); const file = await admitReplica(path.join(root, 'durable'), binding);
    await walOnlyCopy(replicaSource(), file, 'UPDATE durable_schema SET version = version - 1');
    await expect(openLocalDurableStorage(file)).rejects.toBeInstanceOf(DurableReplicaFormatError);
    const db = new DatabaseSync(file);
    try {
      expect(db.prepare('SELECT version FROM durable_schema').get()).toEqual({ version: 1 });
      expect(db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table'").get()).toEqual({ n: 9 });
    } finally { db.close(); }
  });
  it('real cross-process OS lock refuses overlap and becomes available only after KILL close receipt', async () => {
    const { root, binding } = await setup(); const file = await admitReplica(path.join(root, 'durable'), binding);
    const code = "const {DatabaseSync}=require('node:sqlite'); const db=new DatabaseSync(process.argv[1]); db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE owner (slot INTEGER PRIMARY KEY CHECK(slot=1), lease_id TEXT NOT NULL); BEGIN EXCLUSIVE;'); db.prepare('INSERT INTO owner VALUES(1,?)').run('old-lease'); db.exec('COMMIT'); console.log('locked'); setInterval(()=>{},1000);";
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
  it('projects view changes: streamed text once, tool ends before their result, assistant usage', () => {
    const conversation = { id: 1 } as never;
    const assistant = (id: number, text: string, extra: object = {}) => ({ id, conversationId: 1, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text }], ...extra }] });
    const result = (id: number, callId: string) => ({ id, conversationId: 1, kind: 'pi.toolResult', model: [{ role: 'toolResult', toolCallId: callId, isError: false, content: [] }] });
    const view = (entries: object[], live: object, before?: number) => ({ conversation, entries, ...(before === undefined ? {} : { before }), docs: { 'pi.live': live } }) as never;
    const projection = new DurableViewProjection(view([assistant(1, 'earlier')], {}));
    // Attachment history is silent; a partial reports what each text block gained, the entry only its tail.
    expect(projection.advance(view([assistant(1, 'earlier')], { generation: { attempt: 1, message: { content: [{ type: 'text', text: 'He' }] } } }))).toEqual([{ type: 'text', delta: 'He' }]);
    expect(projection.advance(view([assistant(1, 'earlier')], { generation: { attempt: 1, message: { content: [{ type: 'text', text: 'Hello' }] } } }))).toEqual([{ type: 'text', delta: 'llo' }]);
    const answer = assistant(2, 'Hello world');
    expect(projection.advance(view([assistant(1, 'earlier'), answer], { run: { taskId: 1, inputs: [], turns: 0 }, tools: [{ callId: 'c1', name: 'bash', status: 'running', taskId: 5 }] })))
      .toEqual([{ type: 'text', delta: ' world' }, { type: 'assistant', entry: answer }]);
    // A done slot ends with its result entry, in append order; a faulted one has none.
    const done = result(3, 'c1');
    expect(projection.advance(view([answer, done], { tools: [{ callId: 'c1', name: 'bash', status: 'done', taskId: 5, entry: 3 }, { callId: 'c2', name: 'read', status: 'done', taskId: 6 }] })))
      .toEqual([{ type: 'tool_end', callId: 'c1', tool: 'bash', entry: done }, { type: 'tool_end', callId: 'c2', tool: 'read' }]);
    // Slots stay listed as done until the run ends: each ended once.
    expect(projection.advance(view([answer, done], { tools: [{ callId: 'c1', name: 'bash', status: 'done', taskId: 5, entry: 3 }, { callId: 'c2', name: 'read', status: 'done', taskId: 6 }] }))).toEqual([]);
    // An answer with no partial before it is reported whole, once.
    const whole = assistant(4, 'All at once');
    expect(projection.advance(view([answer, done, whole], {}))).toEqual([{ type: 'text', delta: 'All at once' }, { type: 'assistant', entry: whole }]);
    // A window that dropped entries asks for them by ID; retry is never expected in this lane.
    const skipped = view([assistant(9, 'later')], { generation: { attempt: 2, retry: { at: 0, error: 'x' } } }, 8);
    expect(projection.missing(skipped)).toEqual({ minEntryId: 5, maxEntryId: 8 });
    expect(projection.advance(skipped, [assistant(5, 'missed')] as never).map(event => event.type)).toEqual(['text', 'assistant', 'text', 'assistant', 'unexpected']);
    expect(projection.last).toBe(9);
    // A value can fold a round's tool result with the next round's partial: the tool ends before the new text.
    const next = new DurableViewProjection(view([assistant(1, 'x')], { tools: [{ callId: 'c9', name: 'bash', status: 'running', taskId: 9 }] }));
    const ran = result(2, 'c9');
    expect(next.advance(view([ran], { tools: [{ callId: 'c9', name: 'bash', status: 'done', taskId: 9, entry: 2 }], generation: { attempt: 1, message: { content: [{ type: 'text', text: 'Final ' }] } } })))
      .toEqual([{ type: 'tool_end', callId: 'c9', tool: 'bash', entry: ran }, { type: 'text', delta: 'Final ' }]);
    expect(projectDurableEvent({ type: 'text', delta: 'ok' })).toEqual([{ type: 'progress', text: 'ok' }]);
    expect(projectDurableEvent({ type: 'tool_end', callId: 'id', tool: 'bash' })).toMatchObject([{ type: 'tool_result', isError: true }]);
    expect(projectDurableEvent({ type: 'assistant', entry: assistant(2, 'x', { usage: { input: 1, output: 1, cacheRead: 2, cacheWrite: 0, totalTokens: 4 } }) as never }))
      .toEqual([{ type: 'usage', inputTokens: 3, cachedInputTokens: 2, outputTokens: 1, totalTokens: 4 }]);
  });
});
