import { TeamNotificationRelay } from '../bin/team-notification-relay';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalTeamWorkspace, encodeTeamMemberContext, TEAM_WORKSPACE_DIRECTORY } from '../daemon/team-workspace';
import { parseTeamNotificationSnapshotParams } from '../daemon/control-protocol';
import { acquireTeamRelayLock } from '../bin/commands/team-relay';
import { parseCodexTeamBindings, loadCodexTeamBindings, queueCodexTeamNotification, preflightCodexRelay, validateCodexRelayEndpoint } from '../bin/team-codex-relay';

const dirs: string[] = [];
const receipt = '11111111-1111-4111-8111-111111111111';
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-relay-test-')); dirs.push(dir);
  const workspace = new LocalTeamWorkspace(dir);
  await workspace.createWorkspace({ workspaceId: 'room', members: ['alice', 'bob'], limits: { maxMembers: 2, maxMessages: 20, maxBytes: 4096 } });
  const leases = await Promise.all(['alice', 'bob'].map(memberId => workspace.createMemberLease({ workspaceId: 'room', memberId })));
  const document = { version: 1, bindings: leases.map((lease, i) => ({ context: encodeTeamMemberContext(lease), threadId: `00000000-0000-4000-8000-00000000000${i}`, endpoint: `ws://127.0.0.1:${9000+i}`, afterSeq: 0 })) };
  const bindings = parseCodexTeamBindings(document, 'room');
  const enqueue = vi.fn(async (_binding: unknown, _seq: number, _signal: AbortSignal) => receipt);
  const snapshot = vi.fn((binding: typeof bindings[number], afterSeq: number) => workspace.notificationSnapshot({ lease: binding.lease, afterSeq }));
  return { dir, workspace, leases, document, bindings, enqueue, snapshot };
}

describe('notification authority', () => {
  it('is byte-for-byte read only; excludes self, coalesces peers and never permits unread ack', async () => {
    const { dir, workspace: w, leases: [a, b] } = await setup();
    await w.postMessage({ lease: a!, body: 'self' });
    await w.postMessage({ lease: b!, body: 'private peer body' });
    await w.postMessage({ lease: b!, body: 'latest' });
    const file = path.join(dir, TEAM_WORKSPACE_DIRECTORY, 'state.json');
    const before = await fs.readFile(file, 'utf8');
    expect(await w.notificationSnapshot({ lease: a! })).toMatchObject({ latestPeerSeq: 3, acknowledgedThroughSeq: 0 });
    expect(await w.notificationSnapshot({ lease: b!, afterSeq: 1 })).toMatchObject({ latestPeerSeq: null });
    expect(await fs.readFile(file, 'utf8')).toBe(before);
    await expect(w.ackMessages({ lease: a!, throughSeq: 3 })).rejects.toThrow();
    await w.readMessages({ lease: a! }); await w.ackMessages({ lease: a!, throughSeq: 3 });
    expect(await w.notificationSnapshot({ lease: a!, afterSeq: 0 })).toMatchObject({ latestPeerSeq: null, acknowledgedThroughSeq: 3 });
  });
  it('fails snapshot on revoked grants and rejects unknown wire fields', async () => {
    const { workspace, leases, document } = await setup();
    expect(parseTeamNotificationSnapshotParams({ context: document.bindings[0]!.context, afterSeq: 0 })).toBeDefined();
    expect(parseTeamNotificationSnapshotParams({ context: document.bindings[0]!.context, body: 'unexpected' })).toBeUndefined();
    await workspace.revokeMemberLease({ lease: leases[0]! });
    await expect(workspace.notificationSnapshot({ lease: leases[0]! })).rejects.toThrow();
  });
});

describe('Codex relay state machine', () => {
  it('defers an unready member without spending attempts or moving its watermark', async () => {
    const s = await setup(); let open = false;
    const relay = new TeamNotificationRelay({ ...s, maxNotifications: 1, describe: binding => ({ threadId: binding.threadId }), ready: async () => open });
    await s.workspace.postMessage({ lease: s.leases[0]!, body: 'peer message' });
    await relay.tick(); await relay.tick();
    expect(s.enqueue).not.toHaveBeenCalled(); expect(relay.status().attempts).toBe(0);
    expect(relay.status().bindings[1]!.notifiedThroughSeq).toBe(0);
    open = true; await relay.tick();
    expect(relay.status()).toMatchObject({ state: 'budget_exhausted', attempts: 1 });
    expect(s.enqueue).toHaveBeenCalledTimes(1);
  });
  it('serializes ticks and advances notification watermark without advancing receipt', async () => {
    const s = await setup(); const relay = new TeamNotificationRelay({ describe: binding => ({ threadId: binding.threadId }), ...s, maxNotifications: 2 });
    await s.workspace.postMessage({ lease: s.leases[0]!, body: 'request' });
    await Promise.all([relay.tick(), relay.tick(), relay.tick()]); await relay.tick();
    expect(s.enqueue).toHaveBeenCalledTimes(1);
    expect(s.enqueue.mock.calls[0]![0]).toBe(s.bindings[1]);
    expect(relay.status().bindings[1]!.notifiedThroughSeq).toBe(1);
    await s.workspace.postMessage({ lease: s.leases[1]!, body: 'reply' }); await relay.tick();
    expect(relay.status()).toMatchObject({ state: 'budget_exhausted', attempts: 2 });
    relay.resume(); await relay.tick(); expect(s.enqueue).toHaveBeenCalledTimes(2);
    expect((await s.workspace.notificationSnapshot({ lease: s.leases[0]! })).acknowledgedThroughSeq).toBe(0);
    expect(JSON.stringify(relay.status())).not.toContain(s.bindings[0]!.context);
  });
  it('preflights both leases before any delivery and stops on revoke', async () => {
    const s = await setup(); await s.workspace.postMessage({ lease: s.leases[0]!, body: 'request' });
    await s.workspace.revokeMemberLease({ lease: s.leases[0]! });
    const relay = new TeamNotificationRelay({ describe: binding => ({ threadId: binding.threadId }), ...s, maxNotifications: 2 }); await relay.tick();
    expect(relay.status()).toMatchObject({ state: 'failed', attempts: 0, error: 'snapshot_failed' }); expect(s.enqueue).not.toHaveBeenCalled();
  });
  it('pause during snapshot prevents delivery, resume preserves budget', async () => {
    const s = await setup(); await s.workspace.postMessage({ lease: s.leases[0]!, body: 'request' });
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const relay = new TeamNotificationRelay({ describe: binding => ({ threadId: binding.threadId }), ...s, maxNotifications: 1, snapshot: async (b, seq) => { await gate; return s.snapshot(b, seq); } });
    const tick = relay.tick(); relay.pause(); release(); await tick; expect(s.enqueue).not.toHaveBeenCalled();
    relay.resume(); await relay.tick(); expect(relay.status()).toMatchObject({ state: 'budget_exhausted', attempts: 1 });
  });
  it.each(['reject', 'malformed'])('counts failed attempts and never retries (%s)', async kind => {
    const s = await setup(); await s.workspace.postMessage({ lease: s.leases[0]!, body: 'request' });
    const enqueue = vi.fn(async () => { if (kind === 'reject') throw new Error('private upstream detail'); return 'not-a-receipt'; });
    const relay = new TeamNotificationRelay({ describe: binding => ({ threadId: binding.threadId }), ...s, enqueue, maxNotifications: 2 }); await relay.tick(); relay.resume(); await relay.tick();
    expect(relay.status()).toMatchObject({ state: 'failed', attempts: 1, error: 'queue_delivery_unknown' }); expect(enqueue).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(relay.status())).not.toContain('private upstream');
  });
  it('stop aborts an in-flight enqueue without issuing another', async () => {
    const s = await setup(); await s.workspace.postMessage({ lease: s.leases[0]!, body: 'a' }); await s.workspace.postMessage({ lease: s.leases[1]!, body: 'b' });
    let entered!: () => void; const ready = new Promise<void>(r => { entered = r; });
    const enqueue = vi.fn(async (_b, _seq, signal: AbortSignal) => { entered(); return new Promise<string>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); });
    const relay = new TeamNotificationRelay({ describe: binding => ({ threadId: binding.threadId }), ...s, enqueue, maxNotifications: 2 }); const tick = relay.tick(); await ready; relay.stop(); await tick;
    expect(relay.status()).toMatchObject({ state: 'stopped', attempts: 1 }); expect(enqueue).toHaveBeenCalledTimes(1);
  });
  it.each(['identity', 'expired', 'extra'])('rejects malformed snapshot before notifying (%s)', async kind => {
    const s = await setup(); const bindings = kind === 'expired' ? s.bindings.map(b => ({ ...b, lease: { ...b.lease, expiresAt: '2000-01-01T00:00:00.000Z' } })) : s.bindings;
    const snapshot = async (b: typeof bindings[number], seq: number) => ({ ...await s.snapshot(s.bindings.find(x => x.threadId === b.threadId)!, seq), ...(kind === 'identity' ? { memberId: 'wrong' } : kind === 'expired' ? { expiresAt: b.lease.expiresAt } : { body: 'forbidden' }) });
    const relay = new TeamNotificationRelay({ describe: binding => ({ threadId: binding.threadId }), ...s, bindings, snapshot, maxNotifications: 2 }); await relay.tick();
    expect(relay.status().state).toBe('failed'); expect(s.enqueue).not.toHaveBeenCalled();
  });
});

describe('private bindings and native transport', () => {
  it('rejects remote endpoints, ambiguous bindings, public files and symlinks', async () => {
    const s = await setup();
    for (const value of ['ws://example.com:9000', 'ws://localhost:9000', 'wss://127.0.0.1:9000', 'ws://user:secret@127.0.0.1:9000', 'unix://relative', 'ws://127.0.0.1:9000/other']) expect(() => validateCodexRelayEndpoint(value)).toThrow();
    expect(() => validateCodexRelayEndpoint('unix:///tmp/test.sock')).not.toThrow();
    expect(() => parseCodexTeamBindings(s.document, 'wrong')).toThrow();
    expect(() => parseCodexTeamBindings({ version: 1, bindings: [s.document.bindings[0], s.document.bindings[0]] }, 'room')).toThrow();
    const file = path.join(s.dir, 'bindings.json'); await fs.writeFile(file, JSON.stringify(s.document), { mode: 0o600 });
    expect(await loadCodexTeamBindings(file, 'room')).toEqual(s.bindings);
    await fs.chmod(file, 0o644); await expect(loadCodexTeamBindings(file, 'room')).rejects.toThrow();
    await fs.chmod(file, 0o600); await fs.symlink(file, file + '.link'); await expect(loadCodexTeamBindings(file + '.link', 'room')).rejects.toThrow();
  });
  it('locks a room exclusively and releases only on explicit cleanup', async () => {
    const { dir } = await setup(); const release = await acquireTeamRelayLock(dir, 'room');
    await expect(acquireTeamRelayLock(dir, 'room')).rejects.toThrow('lock unavailable'); await release();
    await (await acquireTeamRelayLock(dir, 'room'))();
  });
  it('validates native version and exact-thread queue receipt without passing bearer material', async () => {
    const s = await setup(); const bin = path.join(s.dir, 'fake-codex'); const argv = path.join(s.dir, 'argv.json');
    const write = async (output: string, code = 0) => fs.writeFile(bin, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(argv)}, JSON.stringify(process.argv.slice(2))); console.log(${JSON.stringify(output)}); process.exit(${code});`, { mode: 0o700 });
    const input = { codexBin: bin, binding: s.bindings[0]!, throughSeq: 2, signal: new AbortController().signal };
    await write('codex-cli 0.153.4'); expect(await preflightCodexRelay(bin, input.signal)).toBe('0.153.4');
    await write('codex-cli 0.153.5'); await expect(preflightCodexRelay(bin, input.signal)).rejects.toThrow();
    await write(`Queued message ${receipt} for thread ${input.binding.threadId}.`); expect(await queueCodexTeamNotification(input)).toBe(receipt);
    const args = JSON.parse(await fs.readFile(argv, 'utf8')); expect(args.slice(0,5)).toEqual(['queue', '--remote', input.binding.endpoint, '--thread', input.binding.threadId]); expect(JSON.stringify(args)).not.toContain(input.binding.context);
    await write(`Queued message ${receipt} for thread ${s.bindings[1]!.threadId}.`); await expect(queueCodexTeamNotification(input)).rejects.toThrow('invalid');
    await write('sensitive stderr', 1); await expect(queueCodexTeamNotification(input)).rejects.toThrow('delivery is unknown');
    const abort = new AbortController(); abort.abort(); await expect(queueCodexTeamNotification({ ...input, signal: abort.signal })).rejects.toThrow('unknown');
  });
});
