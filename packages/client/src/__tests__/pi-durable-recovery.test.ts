import { describe, expect, it, afterEach } from 'vitest';
import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { DurableRecovery } from '../adapters/pi-durable/recovery';
import { durableToolDenial } from '../adapters/pi-durable/guard';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('durable parent recovery authority', () => {
  it('feature defaults off and enabled adapter advertises only the capabilities it provides', async () => {
    expect(new PiAdapter().descriptor.capabilities.durablePi).toBeUndefined();
    const adapter = new PiAdapter({ durablePi: { replicaRoot: '/private/store/durable' } });
    expect(adapter.descriptor.capabilities).toMatchObject({ durablePi: true, steer: false, resume: false, permissionModes: ['auto'] });
    expect((await adapter.prepare({ policy: { mode: 'readonly' }, offer: {} } as never)).kind).toBe('reject');
    expect((await adapter.prepare({ policy: { mode: 'auto', network: false }, offer: {} } as never)).kind).toBe('reject');
  });

  it('commits respawn intent before returning permission and caps attempts at two', async () => {
    const writes: string[] = [];
    const recovery = new DurableRecovery({ ownsLease: () => true, record: async (kind, n) => { writes.push(`${kind}:${n}`); } });
    expect(await recovery.crash()).toBe(1); expect(writes).toEqual(['respawn-intent:1']);
    expect(await recovery.crash()).toBe(2); await expect(recovery.crash()).rejects.toThrow('refused');
  });
  it('never resumes a tool without a committed result, including journal failure before ACK', async () => {
    const recovery = new DurableRecovery({ ownsLease: () => true, record: async () => { throw new Error('fsync failed'); } });
    await expect(recovery.beforeTool('tool')).rejects.toThrow('fsync');
    await expect(recovery.crash()).rejects.toThrow('refused');
  });
  it('clears only committed tool intent and rejects result spoofing', async () => {
    const recovery = new DurableRecovery({ ownsLease: () => true, record: async () => {} });
    await expect(recovery.committedTool('unknown')).rejects.toThrow('no parent');
    await recovery.beforeTool('tool'); await recovery.committedTool('tool'); expect(await recovery.crash()).toBe(1);
  });
  it('refuses cancellation and lease loss even during journal append', async () => {
    let owned = true;
    const recovery = new DurableRecovery({ ownsLease: () => owned, record: async () => { owned = false; } });
    await expect(recovery.crash()).rejects.toThrow('lease ended');
  });
  it('denies structured path escape and symlink alias, while declaring shell path freedom', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'byok-durable-guard-')); roots.push(root);
    const home = path.join(root, 'home'), store = path.join(root, 'store'); await mkdir(home); await mkdir(store);
    await symlink(store, path.join(home, 'alias'), 'junction');
    expect(await durableToolDenial('write', { path: 'ok/new.txt' }, home, store)).toBeUndefined();
    expect(await durableToolDenial('read', { path: '../store/file' }, home, store)).toBeDefined();
    expect(await durableToolDenial('edit', { path: 'alias/file' }, home, store)).toBeDefined();
    expect(await durableToolDenial('bash', { command: 'BYOK_TOKEN=x echo ok' }, home, store)).toBeDefined();
    expect(await durableToolDenial('bash', { command: 'cat /tmp/other' }, home, store)).toBeUndefined();
  });
});
