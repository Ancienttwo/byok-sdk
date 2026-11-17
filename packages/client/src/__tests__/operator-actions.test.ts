import { createTestDeviceStore } from './fixtures/device-credentials';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  archiveAgentTerminalMessages, exportDeviceSupportBundle, quarantineDeviceOperationalHealth, releaseAgentHomeLeases,
  DeviceOperatorError, AgentHomeManager, stableAgentHomeOwnerId, type DaemonConfig,
} from '../index';
import { currentAgentHomeLeaseWriter } from '../agent-home-writer';
import { DeviceStore } from '../daemon/store';
import { connectControlClient } from '../daemon/control-client';
import { acquireDaemonOwner } from '../util/daemon-owner';
import { AgentMessageOutbox } from '../daemon/agent-message-outbox';
import { OPERATIONAL_HEALTH_FILENAME } from '../daemon/operational-health';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { currentBootId } from '../adapters/process-tree';
import { OWNED_PROCESSES_DIRECTORY, OwnedProcessLedger, OwnedProcessResidueError } from '../daemon/owned-process-ledger';
import { readProcessTable } from '../runtime/oar-process-tree.js';

vi.mock('../daemon/control-client', () => ({ connectControlClient: vi.fn() }));
let root: string;
let config: DaemonConfig;
const agentRef = { agentId: '11111111-1111-4111-8111-111111111111', profileRevision: '2' };
const target = { confirmed: true as const, expectedDeviceId: 'device-a', expectedTenantId: 'tenant-a', agentRef };
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-operators-'));
  config = { productName: 'Operator fixture', productId: 'operator-fixture', localAgentRelease: { version: 'test' },
    serverUrl: 'https://redacted.example.invalid/secret', storeDir: path.join(root, 'store'),
    agentHome: { hostStorageRoot: path.join(root, 'homes') } };
  vi.mocked(connectControlClient).mockReset();
  vi.mocked(connectControlClient).mockResolvedValue({ ok: false, reason: 'offline' });
});
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });
async function seed() {
  await createTestDeviceStore(config.storeDir!, undefined, config.productId).save({ deviceId: 'device-a', tenantId: 'tenant-a', devicePublicKey: 'public' });
  const binding = await new AgentHomeManager(config.agentHome!).acquire(agentRef);
  const home = binding.lease.cwd;
  await binding.lease.release();
  const outbox = await AgentMessageOutbox.open(home);
  for (const outcome of ['refused', 'held', 'draft', 'revoked'] as const) {
    const record = await outbox.appendDraft({ taskId: outcome, tenantId: 'tenant-a', agentRef: { ...agentRef, profileRevision: '1' },
      requirement: { mode: 'required', contract: 'chat.v1', contentType: 'text/markdown', maxBytes: 10_000 },
      contentType: 'text/markdown', body: 'private-message-body', sessionRef: 'session-a', maxPendingEvents: 10, maxPendingBytes: 100_000 });
    if (outcome === 'revoked') await outbox.revoke(outcome);
    else if (outcome !== 'draft') await outbox.applyDisposition(outcome, { agentRef: record.agentRef, sessionRef: 'session-a',
      contract: record.contract, messageId: record.messageId, cursor: record.cursor, contentHash: record.contentHash,
      outcome, receiptId: '22222222-2222-4222-8222-222222222222', reasonCode: 'fixture' });
  }
  return { home, outbox, before: await fs.readFile(outbox.outboxPath, 'utf8') };
}

describe('public device operator boundaries', () => {
  it('refuses missing confirmation and invalid input before control or disk access', async () => {
    await expect(quarantineDeviceOperationalHealth(config, { confirmed: false } as never)).rejects.toMatchObject({ code: 'confirmation-required' });
    await expect(archiveAgentTerminalMessages(config, { ...target, confirmed: false, archiveDirectory: root } as never)).rejects.toMatchObject({ code: 'confirmation-required' });
    await expect(archiveAgentTerminalMessages(config, { ...target, agentRef: { agentId: '../escape', profileRevision: '1' }, archiveDirectory: root })).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(exportDeviceSupportBundle(config, { outputPath: 'relative' })).rejects.toMatchObject({ code: 'invalid-input' });
    // #1097: never into the store itself.
    await expect(exportDeviceSupportBundle(config, { outputPath: path.join(config.storeDir!, 'support.json') })).rejects.toMatchObject({ code: 'invalid-input' });
    expect(connectControlClient).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('refuses reachable control and an offline-but-owned store without mutation', async () => {
    const close = vi.fn();
    vi.mocked(connectControlClient).mockResolvedValue({ ok: true, client: { close } } as never);
    await expect(quarantineDeviceOperationalHealth(config, { confirmed: true })).rejects.toMatchObject({ code: 'daemon-running' });
    expect(close).toHaveBeenCalled();
    vi.mocked(connectControlClient).mockResolvedValue({ ok: false, reason: 'offline' });
    const owner = await acquireDaemonOwner(config.storeDir!, 'doctor');
    try {
      await expect(quarantineDeviceOperationalHealth(config, { confirmed: true })).rejects.toMatchObject({ code: 'store-busy' });
      await expect(archiveAgentTerminalMessages(config, { ...target, archiveDirectory: path.join(root, 'audit') })).rejects.toMatchObject({ code: 'store-busy' });
    } finally { await owner.release(); }
  });

  it('quarantines corrupt health with durable evidence and then reports not-needed', async () => {
    await fs.mkdir(config.storeDir!);
    const source = path.join(config.storeDir!, OPERATIONAL_HEALTH_FILENAME);
    await fs.writeFile(source, '{broken-health');
    const result = await quarantineDeviceOperationalHealth(config, { confirmed: true });
    expect(result.status).toBe('quarantined');
    if (result.status !== 'quarantined') throw Error('missing receipt');
    expect(result).toMatchObject({ scope: 'device', sizeBytes: 14 });
    const files = await fs.readdir(config.storeDir!, { recursive: true });
    const evidence = files.find(file => path.basename(file.toString()) === result.evidenceName)!;
    expect(await fs.readFile(path.join(config.storeDir!, evidence.toString()), 'utf8')).toBe('{broken-health');
    await expect(fs.stat(source)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await quarantineDeviceOperationalHealth(config, { confirmed: true })).toMatchObject({ status: 'not-needed', reason: 'missing' });
  });

  it('exports host adapter observations with redaction and never overwrites a bundle', async () => {
    const outputPath = path.join(root, 'support.json');
    const result = await exportDeviceSupportBundle(config, { outputPath, adapters: [new StubRuntimeAdapter()] });
    expect(result).toMatchObject({ status: 'written', bundleVersion: 1 });
    const bytes = await fs.readFile(outputPath, 'utf8');
    const report = JSON.parse(bytes);
    expect(report.runtimes).toHaveLength(1);
    expect(report.redaction.policy).toBe('allowlist-v1');
    expect(bytes).not.toContain(root);
    expect(bytes).not.toContain('redacted.example.invalid');
    await expect(exportDeviceSupportBundle(config, { outputPath, adapters: [] })).rejects.toMatchObject({ code: 'output-exists' });
    expect(await fs.readFile(outputPath, 'utf8')).toBe(bytes);
    await expect(fs.stat(config.storeDir!)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('archives exact Agent terminal bodies/receipts, preserves historical refs and leaves held/draft live', async () => {
    const { home } = await seed();
    const archiveDirectory = path.join(root, 'audit');
    const receipt = await archiveAgentTerminalMessages(config, { ...target, archiveDirectory });
    expect(receipt).toMatchObject({ status: 'archived', archivedRecords: 2 });
    if (receipt.status !== 'archived') throw Error('missing receipt');
    const audit = await fs.readFile(path.join(archiveDirectory, receipt.archiveFileName), 'utf8');
    expect(audit).toContain('private-message-body');
    expect(audit).toContain('"profileRevision":"1"');
    expect(audit).toContain('"kind":"revoke"');
    const reopened = await AgentMessageOutbox.open(home);
    expect(reopened.records().map(record => record.taskId)).toEqual(['held', 'draft']);
    expect(await archiveAgentTerminalMessages(config, { ...target, archiveDirectory: path.join(root, 'unused') })).toMatchObject({ status: 'not-needed' });
    await expect(fs.stat(path.join(root, 'unused'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.stringify(receipt)).not.toContain('private-message-body');
  });

  it('refuses wrong device, foreign record identity, a busy Agent and output collisions without changing the live log', async () => {
    const { outbox, before } = await seed();
    const archiveDirectory = path.join(root, 'audit');
    await expect(archiveAgentTerminalMessages(config, { ...target, expectedDeviceId: 'wrong', archiveDirectory })).rejects.toMatchObject({ code: 'target-mismatch' });
    const binding = await new AgentHomeManager(config.agentHome!).acquire(agentRef);
    try { await expect(archiveAgentTerminalMessages(config, { ...target, archiveDirectory })).rejects.toMatchObject({ code: 'agent-busy' }); }
    finally { await binding.lease.release(); }
    // A marker an earlier release left for this store: the refusal keeps why, and what clears it.
    const marker = path.join(binding.lease.canonicalHome, '.byok', 'agent-home.lease');
    await fs.writeFile(marker, JSON.stringify({ version: 1, ownerId: stableAgentHomeOwnerId(DeviceStore.resolveDir(config.productId, config.storeDir), config.productId),
      leaseId: 'earlier-release', agentRef, canonicalHome: binding.lease.canonicalHome }));
    const held = await archiveAgentTerminalMessages(config, { ...target, archiveDirectory }).catch((error: unknown) => error);
    expect(held).toMatchObject({ code: 'agent-lease-held', blockedBy: 'legacy-marker' });
    expect((held as Error).message).toMatch(/never reclaimed automatically/u);
    expect((held as Error).message).not.toContain(marker);
    await fs.rm(marker);
    await fs.mkdir(archiveDirectory);
    await expect(archiveAgentTerminalMessages(config, { ...target, archiveDirectory })).rejects.toMatchObject({ code: 'output-exists' });
    expect(await fs.readFile(outbox.outboxPath, 'utf8')).toBe(before);
    const foreign = before.replaceAll('tenant-a', 'tenant-foreign');
    await fs.writeFile(outbox.outboxPath, foreign);
    await expect(archiveAgentTerminalMessages(config, { ...target, archiveDirectory: path.join(root, 'new') })).rejects.toMatchObject({ code: 'target-mismatch' });
    expect(await fs.readFile(outbox.outboxPath, 'utf8')).toBe(foreign);
  });

  it('#393: a surviving crash residue refuses the archive with its own closed code and the operator remedy', async () => {
    const { outbox, before } = await seed();
    vi.spyOn(OwnedProcessLedger.prototype, 'reconcile').mockRejectedValueOnce(new OwnedProcessResidueError(
      { recorded: 1, found: 1, terminated: 0, survived: 1, liveWriter: 0 }, [path.join(config.storeDir!, OWNED_PROCESSES_DIRECTORY, 'record.json')],
    ));
    const refusal = await archiveAgentTerminalMessages(config, { ...target, archiveDirectory: path.join(root, 'audit') }).catch((error: unknown) => error);
    expect(refusal).toMatchObject({ code: 'owned-process-residue' });
    expect((refusal as Error).message).toContain('verify the processes are gone, then delete that record from the owned-processes directory');
    // Closed code: no path leaves the operator boundary.
    expect((refusal as Error).message).not.toContain(root);
    expect(await fs.readFile(outbox.outboxPath, 'utf8')).toBe(before);
  });

  it('#393: refuses on an unreadable owned-process record before touching the Agent home', async () => {
    const { outbox, before } = await seed();
    const ledger = new OwnedProcessLedger(config.storeDir!);
    await ledger.adopted({ pgid: 4242, rootStart: 'Tue Oct 13 10:00:00 2026', bootId: 'boot', writerPid: 999_999, writerStart: 'gone' });
    const [name] = await fs.readdir(path.join(config.storeDir!, OWNED_PROCESSES_DIRECTORY));
    await fs.writeFile(path.join(config.storeDir!, OWNED_PROCESSES_DIRECTORY, name!), '{}');
    await expect(archiveAgentTerminalMessages(config, { ...target, archiveDirectory: path.join(root, 'audit') })).rejects.toMatchObject({ code: 'operation-failed' });
    expect(await fs.readFile(outbox.outboxPath, 'utf8')).toBe(before);
    await expect(fs.stat(path.join(root, 'audit'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'win32')('#393: ends a crashed daemon\u2019s recorded runtime group before reclaiming its Agent home lease', async () => {
    await seed();
    // An orphaned group leader (re-parented, as after a daemon SIGKILL).
    const pidFile = path.join(root, 'orphan.pid');
    const launcher = spawn('/bin/sh', ['-c', `perl -e 'setpgrp(0, 0); exec @ARGV' /bin/sh -c 'echo $$ > "$0"; exec sleep 600' "$1" </dev/null >/dev/null 2>&1 &`, 'launcher', pidFile], { stdio: 'ignore' });
    await new Promise<void>((resolve) => launcher.once('exit', () => resolve()));
    await expect.poll(async () => (await fs.readFile(pidFile, 'utf8').catch(() => '')).trim()).not.toBe('');
    const pgid = Number((await fs.readFile(pidFile, 'utf8')).trim());
    const rootStart = readProcessTable().get(pgid)!.start;
    try {
      await new OwnedProcessLedger(config.storeDir!).adopted({ pgid, rootStart, bootId: currentBootId(), writerPid: 999_999, writerStart: 'gone' });
      const receipt = await archiveAgentTerminalMessages(config, { ...target, archiveDirectory: path.join(root, 'audit') });
      expect(receipt).toMatchObject({ status: 'archived' });
      expect(readProcessTable().get(pgid)?.start === rootStart).toBe(false);
      expect(await fs.readdir(path.join(config.storeDir!, OWNED_PROCESSES_DIRECTORY))).toEqual([]);
    } finally {
      if (readProcessTable().get(pgid)?.start === rootStart) process.kill(-pgid, 'SIGKILL');
    }
  });

  it('refuses a symlinked outbox and hides filesystem failures', async () => {
    const { outbox, before } = await seed();
    const external = path.join(root, 'external.jsonl');
    await fs.rename(outbox.outboxPath, external);
    await fs.symlink(external, outbox.outboxPath);
    await expect(archiveAgentTerminalMessages(config, { ...target, archiveDirectory: path.join(root, 'audit') })).rejects.toMatchObject({ code: 'source-unavailable' });
    expect(await fs.readFile(external, 'utf8')).toBe(before);
    try { await exportDeviceSupportBundle(config, { outputPath: path.join(root, 'private-secret-missing', 'bundle'), adapters: [] }); }
    catch (error) {
      expect(error).toBeInstanceOf(DeviceOperatorError);
      expect(String(error)).not.toContain('private-secret-missing');
      expect((error as Error).cause).toBeUndefined();
    }
  });

  describe('releaseAgentHomeLeases (#2333)', () => {
    const DEAD_PID = 2147483646;
    const ownerOf = (storeDir: string) => stableAgentHomeOwnerId(DeviceStore.resolveDir(config.productId, storeDir), config.productId);
    const gone = async () => ({ ...(await currentAgentHomeLeaseWriter())!, pid: DEAD_PID });
    /** A marker in Agent home `agentId`: its JSON fields, or raw bytes. */
    async function marker(agentId: string, fields: Record<string, unknown> | string): Promise<string> {
      const home = path.join(await fs.realpath(root), 'homes', 'agents', agentId);
      await fs.mkdir(path.join(home, '.byok'), { recursive: true });
      const file = path.join(home, '.byok', 'agent-home.lease');
      await fs.writeFile(file, typeof fields === 'string' ? fields
        : JSON.stringify({ version: 1, leaseId: `lease-${agentId}`, agentRef: { agentId, profileRevision: '1' }, canonicalHome: home, ...fields }));
      return file;
    }
    const exists = (file: string) => fs.stat(file).then(() => true, () => false);

    it('releases this store\'s gone and legacy markers and dead temp files, and keeps and counts another owner\'s and corrupt ones', async () => {
      const own = ownerOf(config.storeDir!);
      const dead = await marker('a1', { ownerId: own, writer: await gone() });
      const legacy = await marker('a2', { ownerId: own });
      const foreign = await marker('a3', { ownerId: 'store-product:other', writer: { ...(await gone()), host: 'b'.repeat(64) } });
      const corrupt = await marker('a4', '{');
      // This store's marker from another machine cannot be proved free: kept, not refused.
      const elsewhere = await marker('a5', { ownerId: own, writer: { ...(await gone()), host: 'b'.repeat(64) } });
      const internal = path.dirname(dead);
      const deadTemp = path.join(internal, 'agent-home.lease.00000000-0000-4000-8000-000000000001.tmp');
      const liveTemp = path.join(internal, 'agent-home.lease.00000000-0000-4000-8000-000000000002.tmp');
      const legacyTemp = path.join(internal, 'agent-home.lease.123-4.tmp');
      await fs.writeFile(deadTemp, JSON.stringify({ writer: await gone() }));
      await fs.writeFile(liveTemp, JSON.stringify({ writer: await currentAgentHomeLeaseWriter() }));
      await fs.writeFile(legacyTemp, '{}');

      await expect(releaseAgentHomeLeases(config, { confirmed: true })).resolves.toEqual({ action: 'release-agent-home-leases', scope: 'device',
        released: 2, namedRemoved: false, removedTemps: 2, kept: { own: 1, foreignOwner: 1, corrupt: 1 } });
      expect(await Promise.all([dead, legacy, deadTemp, legacyTemp, foreign, corrupt, elsewhere, liveTemp].map(exists))).toEqual([false, false, false, false, true, true, true, true]);

      // Named once that writer is retired: another owner's marker and a corrupt one.
      await expect(releaseAgentHomeLeases(config, { confirmed: true, marker: { markerPath: foreign, ownerId: 'store-product:wrong' } })).rejects.toMatchObject({ code: 'target-mismatch' });
      await expect(releaseAgentHomeLeases(config, { confirmed: true, marker: { markerPath: foreign, ownerId: 'store-product:other' } })).resolves.toMatchObject({ namedRemoved: true, kept: { own: 1, foreignOwner: 0, corrupt: 1 } });
      await expect(releaseAgentHomeLeases(config, { confirmed: true, marker: { markerPath: corrupt, ownerId: null } })).resolves.toMatchObject({ namedRemoved: true, kept: { corrupt: 0 } });
    });

    it('never removes a marker whose writer is proved running, named or not, and then removes nothing', async () => {
      const own = ownerOf(config.storeDir!);
      const dead = await marker('b1', { ownerId: own, writer: await gone() });
      const running = await marker('b2', { ownerId: 'store-product:other', writer: await currentAgentHomeLeaseWriter() });
      const refusal = await releaseAgentHomeLeases(config, { confirmed: true, marker: { markerPath: running, ownerId: 'store-product:other' } }).catch((error: unknown) => error);
      expect(refusal).toMatchObject({ code: 'agent-lease-held', blockedBy: 'writer-running' });
      expect((refusal as Error).message).not.toContain(running);
      expect(await Promise.all([dead, running].map(exists))).toEqual([true, true]);
      // This store's own marker of a running writer (a memory export beside it) refuses the unnamed release too.
      await fs.writeFile(running, JSON.stringify({ ...JSON.parse(await fs.readFile(running, 'utf8')), ownerId: own }));
      await expect(releaseAgentHomeLeases(config, { confirmed: true })).rejects.toMatchObject({ code: 'agent-lease-held', blockedBy: 'writer-running' });
      expect(await exists(dead)).toBe(true);
    });

    it('frees a home a retired store\'s crash left for another store sharing the root', async () => {
      await seed();
      const retired: DaemonConfig = { ...config, storeDir: path.join(root, 'retired-store') };
      const residue = await marker(agentRef.agentId, { ownerId: ownerOf(retired.storeDir!), agentRef, writer: await gone() });
      const archive = { ...target, archiveDirectory: path.join(root, 'audit') };
      await expect(archiveAgentTerminalMessages(config, archive)).rejects.toMatchObject({ code: 'agent-busy' });
      await expect(releaseAgentHomeLeases(retired, { confirmed: true })).resolves.toMatchObject({ released: 1 });
      expect(await exists(residue)).toBe(false);
      await expect(archiveAgentTerminalMessages(config, archive)).resolves.toMatchObject({ status: 'archived' });
    });
  });
});
