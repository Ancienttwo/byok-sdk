import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonConfig } from '../index';
import type { ConnectControlResult, ControlClient } from '../bin/control-client';
import {
  DoctorConfirmationRequiredError,
  DoctorDaemonRunningError,
  runDoctorCommand,
} from '../bin/commands/doctor';
import {
  collectDiagnostics,
  MAX_QUARANTINE_ENTRIES,
  quarantineCorruptOperationalHealth,
} from '../diagnostics/diagnostics';
import {
  MAX_OPERATIONAL_HEALTH_FILE_BYTES,
  OPERATIONAL_HEALTH_FILENAME,
  OperationalHealthTracker,
} from '../daemon/operational-health';
import { isSqliteAvailable } from '../daemon/journal/sqlite-support';
import { loadSqliteModule } from '../daemon/journal/sqlite-support';
import { acquireDaemonOwner, DaemonOwnerActiveError } from '../daemon/daemon-owner';
import { DAEMON_OWNER_FILENAME } from '../daemon/daemon-owner';
import { freezeRuntimeAdapterDescriptor, type RuntimeAdapter } from '../types';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-diagnostics-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function config(storeDir: string): DaemonConfig {
  return {
    productName: 'Acme',
    productId: 'acme-product',
    serverUrl: 'https://example.invalid/byok',
    workspaceRoot: path.join(storeDir, 'workspace'),
    storeDir,
  };
}

function unreachable(): Promise<ConnectControlResult> {
  return Promise.resolve({ ok: false, reason: 'offline' });
}

function connected(): Promise<ConnectControlResult> {
  const client: ControlClient = {
    request: vi.fn().mockResolvedValue({
      pid: 1,
      uptimeMs: 1,
      paired: false,
      transport: 'open',
      activeTasks: [],
      runtimeIds: [],
      queueWatermarks: [],
      approvals: [],
      approvalsPending: 0,
      operationalHealth: { availability: 'available', state: 'healthy', failureCount: 0, windowMs: 60_000, failureThreshold: 3, crashCount: 0 },
    }),
    subscribe: () => ({ close: vi.fn() }),
    close: vi.fn(),
  };
  return Promise.resolve({ ok: true, client });
}

async function digest(filePath: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(filePath)).digest('hex');
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('test listener did not expose a TCP port'));
      else resolve(address.port);
    });
  });
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return port;
}

describe('diagnostics collector', () => {
  it('reports a corrupt health file without changing its bytes', async () => {
    const dir = await tempDir();
    const healthPath = path.join(dir, OPERATIONAL_HEALTH_FILENAME);
    await fs.writeFile(healthPath, '{corrupt-health', { mode: 0o600 });
    const before = await digest(healthPath);

    const snapshot = await collectDiagnostics(config(dir), dir, { adapters: [], connectControl: unreachable });

    expect(snapshot.health).toMatchObject({ status: 'corrupt', reason: 'operational health state is corrupt JSON' });
    expect(snapshot.checks.find((check) => check.id === 'health')?.status).toBe('fail');
    expect(await digest(healthPath)).toBe(before);
    expect(await fs.readdir(dir)).toEqual([OPERATIONAL_HEALTH_FILENAME]);
  });

  it('reports valid health and bounds quarantine inventory', async () => {
    const dir = await tempDir();
    const tracker = new OperationalHealthTracker(dir, { runId: () => 'run', pid: 1 });
    await tracker.startRun();
    await tracker.markCleanStop();
    const quarantineDir = path.join(dir, 'quarantine');
    await fs.mkdir(quarantineDir);
    await Promise.all(
      Array.from({ length: MAX_QUARANTINE_ENTRIES + 5 }, async (_, index) => {
        const evidenceFile = `evidence-${String(index).padStart(3, '0')}`;
        const bytes = Buffer.from('x');
        await fs.writeFile(path.join(quarantineDir, evidenceFile), bytes);
        await fs.writeFile(
          path.join(quarantineDir, `${evidenceFile}.manifest.json`),
          `${JSON.stringify({
            version: 1,
            quarantinedAt: '2026-08-09T00:00:00.000Z',
            reason: 'test evidence',
            sourcePath: path.join(dir, evidenceFile),
            evidenceFile,
            sha256: createHash('sha256').update(bytes).digest('hex'),
            sizeBytes: bytes.length,
          })}\n`,
        );
      }),
    );

    const snapshot = await collectDiagnostics(config(dir), dir, { adapters: [], connectControl: unreachable });

    expect(snapshot.health.status).toBe('valid');
    expect(snapshot.quarantine.entries).toHaveLength(MAX_QUARANTINE_ENTRIES);
    // Directory enumeration order is intentionally not an authority. The
    // bounded 200-dirent scan can validate 100-105 complete evidence pairs
    // from this 210-dirent fixture depending on the host filesystem order.
    expect(snapshot.quarantine.count).toBeGreaterThanOrEqual(MAX_QUARANTINE_ENTRIES);
    expect(snapshot.quarantine.count).toBeLessThanOrEqual(MAX_QUARANTINE_ENTRIES + 5);
    expect(snapshot.quarantine.truncated).toBe(true);
  });

  it('refuses a symlinked quarantine inventory without following the target', async () => {
    const dir = await tempDir();
    const outside = await tempDir();
    await fs.writeFile(path.join(outside, 'secret.manifest.json'), '{not-readable-evidence');
    await fs.symlink(outside, path.join(dir, 'quarantine'));

    const snapshot = await collectDiagnostics(config(dir), dir, { adapters: [], connectControl: unreachable });

    expect(snapshot.quarantine).toMatchObject({ status: 'unavailable', count: 0 });
    expect(snapshot.checks.find((check) => check.id === 'quarantine')?.status).toBe('fail');
    expect(await fs.readFile(path.join(outside, 'secret.manifest.json'), 'utf8')).toBe('{not-readable-evidence');
  });

  it('fails quarantine diagnostics when a manifest is invalid or unbound', async () => {
    const dir = await tempDir();
    const quarantineDir = path.join(dir, 'quarantine');
    await fs.mkdir(quarantineDir);
    await fs.writeFile(path.join(quarantineDir, 'evidence'), 'bytes');
    await fs.writeFile(path.join(quarantineDir, 'evidence.manifest.json'), '{invalid-json');

    const snapshot = await collectDiagnostics(config(dir), dir, { adapters: [], connectControl: unreachable });

    expect(snapshot.quarantine).toMatchObject({ status: 'unavailable', count: 0 });
    expect(snapshot.checks.find((check) => check.id === 'quarantine')?.status).toBe('fail');
  });

  it.skipIf(process.platform === 'win32')('classifies unreadable health as unavailable and refuses to quarantine unconfirmed corruption', async () => {
    const dir = await tempDir();
    const healthPath = path.join(dir, OPERATIONAL_HEALTH_FILENAME);
    const tracker = new OperationalHealthTracker(dir, { runId: () => 'run', pid: 1 });
    await tracker.startRun();
    await tracker.markCleanStop();
    const before = await digest(healthPath);
    await fs.chmod(healthPath, 0o000);
    try {
      const snapshot = await collectDiagnostics(config(dir), dir, { adapters: [], connectControl: unreachable });
      expect(snapshot.health).toMatchObject({ status: 'unavailable' });
      expect(snapshot.checks.find((check) => check.id === 'health')?.status).toBe('fail');
      await expect(quarantineCorruptOperationalHealth(dir)).rejects.toThrow(/unconfirmed corruption|opened safely/);
    } finally {
      await fs.chmod(healthPath, 0o600);
    }
    expect(await digest(healthPath)).toBe(before);
  });

  it('classifies an oversized health file as unavailable and refuses an unbounded quarantine read', async () => {
    const dir = await tempDir();
    const healthPath = path.join(dir, OPERATIONAL_HEALTH_FILENAME);
    await fs.writeFile(healthPath, JSON.stringify({ version: 1, state: 'healthy', failures: [], crashes: [] }));
    await fs.truncate(healthPath, MAX_OPERATIONAL_HEALTH_FILE_BYTES + 1);

    const snapshot = await collectDiagnostics(config(dir), dir, { adapters: [], connectControl: unreachable });
    expect(snapshot.health).toMatchObject({ status: 'unavailable', sizeBytes: MAX_OPERATIONAL_HEALTH_FILE_BYTES + 1 });
    await expect(quarantineCorruptOperationalHealth(dir)).rejects.toThrow(/unconfirmed corruption/);
    expect((await fs.stat(healthPath)).size).toBe(MAX_OPERATIONAL_HEALTH_FILE_BYTES + 1);
    await expect(fs.stat(path.join(dir, 'quarantine'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.skipIf(process.platform === 'win32')('does not block when device.json is a FIFO', async () => {
    const dir = await tempDir();
    execFileSync('mkfifo', [path.join(dir, 'device.json')]);
    const started = Date.now();
    const snapshot = await collectDiagnostics(config(dir), dir, { adapters: [], connectControl: unreachable });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(snapshot.device.status).toBe('unavailable');
  });

  it('keeps the default control probe bounded when control.token is oversized', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, 'control.token'), 'x'.repeat(257));

    const snapshot = await collectDiagnostics(config(dir), dir, { adapters: [] });

    expect(snapshot.control).toMatchObject({ status: 'offline' });
  });

  it.skipIf(process.platform === 'win32')('does not block when the default control probe sees a FIFO token', async () => {
    const dir = await tempDir();
    execFileSync('mkfifo', [path.join(dir, 'control.token')]);

    const started = Date.now();
    const snapshot = await collectDiagnostics(config(dir), dir, { adapters: [] });

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(snapshot.control).toMatchObject({ status: 'offline' });
  });

  it.skipIf(!isSqliteAvailable())('detects a corrupt journal through a read-only quick_check without moving it', async () => {
    const dir = await tempDir();
    const journalPath = path.join(dir, 'daemon.db');
    await fs.writeFile(journalPath, 'not a sqlite database');
    const before = await digest(journalPath);
    const snapshot = await collectDiagnostics(config(dir), dir, { adapters: [], connectControl: unreachable });
    expect(snapshot.journal).toMatchObject({ status: 'corrupt' });
    expect(await digest(journalPath)).toBe(before);
    expect(await fs.readdir(dir)).toEqual(['daemon.db']);
  });

  it.skipIf(!isSqliteAvailable())('checks a WAL snapshot without creating or changing store sidecars', async () => {
    const dir = await tempDir();
    const { DatabaseSync } = loadSqliteModule();
    const db = new DatabaseSync(path.join(dir, 'daemon.db'));
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES (\'x\');');
    try {
      const beforeNames = (await fs.readdir(dir)).sort();
      const before = new Map(await Promise.all(beforeNames.map(async (name) => [name, await digest(path.join(dir, name))] as const)));
      await collectDiagnostics(config(dir), dir, { adapters: [], connectControl: unreachable });
      const afterNames = (await fs.readdir(dir)).sort();
      expect(afterNames).toEqual(beforeNames);
      for (const name of afterNames) expect(await digest(path.join(dir, name))).toBe(before.get(name));
    } finally {
      db.close();
    }
  });

  it.skipIf(process.platform === 'win32')('does not block or copy when daemon.db is a FIFO', async () => {
    const dir = await tempDir();
    execFileSync('mkfifo', [path.join(dir, 'daemon.db')]);
    const started = Date.now();
    const snapshot = await collectDiagnostics(config(dir), dir, { adapters: [], connectControl: unreachable });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(snapshot.journal.status).toBe('unavailable');
  });

  it('bounds runtime detection and oversized device input', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, 'device.json'), 'x'.repeat(70 * 1024));
    const hanging: RuntimeAdapter = {
      descriptor: freezeRuntimeAdapterDescriptor({
        id: 'hanging',
        supportsDispatchSelection: false,
        capabilities: { steer: false, resume: false, approvalInteractive: false, permissionModes: [] },
        environmentRequirements: { credentialNames: [] },
      }),
      detect: () => new Promise(() => undefined),
      prepare: async () => ({ kind: 'reject', reason: 'not used', retryable: false }),
    };
    const started = Date.now();
    const snapshot = await collectDiagnostics(config(dir), dir, {
      adapters: [hanging],
      connectControl: unreachable,
      runtimeProbeTimeoutMs: 20,
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(snapshot.device.status).toBe('unavailable');
    expect(snapshot.runtimes).toMatchObject([{ present: false }]);
    expect(JSON.stringify(snapshot)).not.toContain('hanging');
  });
});

describe('doctor explicit fix', () => {
  it('requires --yes and refuses to mutate while a daemon is reachable', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, OPERATIONAL_HEALTH_FILENAME), '{bad');
    await expect(runDoctorCommand(config(dir), { fix: true, adapters: [], connectControl: unreachable })).rejects.toBeInstanceOf(
      DoctorConfirmationRequiredError,
    );
    await expect(
      runDoctorCommand(config(dir), { fix: true, confirmed: true, adapters: [], connectControl: connected }),
    ).rejects.toBeInstanceOf(DoctorDaemonRunningError);
    expect(await fs.readFile(path.join(dir, OPERATIONAL_HEALTH_FILENAME), 'utf8')).toBe('{bad');
  });

  it('moves confirmed corrupt bytes to quarantine and writes a matching digest manifest', async () => {
    const dir = await tempDir();
    const sourcePath = path.join(dir, OPERATIONAL_HEALTH_FILENAME);
    const bytes = Buffer.from('{not-json-secret-evidence');
    await fs.writeFile(sourcePath, bytes, { mode: 0o600 });

    const result = await quarantineCorruptOperationalHealth(dir, {
      clock: () => new Date('2026-08-09T06:45:00.000Z'),
    });

    expect(result.status).toBe('quarantined');
    if (result.status !== 'quarantined') throw new Error('expected quarantine result');
    await expect(fs.stat(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
    const evidencePath = path.join(dir, 'quarantine', result.evidenceName);
    expect(await fs.readFile(evidencePath)).toEqual(bytes);
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'quarantine', result.manifestName), 'utf8')) as Record<string, unknown>;
    expect(manifest).toMatchObject({
      sourcePath,
      evidenceFile: result.evidenceName,
      sha256: result.sha256,
      sizeBytes: bytes.length,
      reason: 'operational health state is corrupt JSON',
    });
  });

  it('anchors a relative storeDir before pinning quarantine as the process cwd', async () => {
    const dir = await tempDir();
    const relativeStoreDir = path.relative(process.cwd(), dir);
    const sourcePath = path.join(dir, OPERATIONAL_HEALTH_FILENAME);
    await fs.writeFile(sourcePath, '{relative-store-corrupt');

    const result = await quarantineCorruptOperationalHealth(relativeStoreDir);

    expect(result.status).toBe('quarantined');
    if (result.status !== 'quarantined') throw new Error('expected quarantine result');
    await expect(fs.stat(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
    const manifest = JSON.parse(
      await fs.readFile(path.join(dir, 'quarantine', result.manifestName), 'utf8'),
    ) as { sourcePath: string };
    expect(manifest.sourcePath).toBe(sourcePath);
  });

  it('rejects a raced replacement before any unconfirmed inode enters quarantine', async () => {
    const dir = await tempDir();
    const sourcePath = path.join(dir, OPERATIONAL_HEALTH_FILENAME);
    await fs.writeFile(sourcePath, '{original-corrupt');
    const quarantineDir = path.join(dir, 'quarantine');
    const realChdir = process.chdir.bind(process);
    const chdir = vi.spyOn(process, 'chdir').mockImplementation((target) => {
      if (target === quarantineDir) {
        renameSync(sourcePath, `${sourcePath}.original`);
        writeFileSync(sourcePath, '{replacement-corrupt');
      }
      realChdir(target);
    });

    try {
      await expect(quarantineCorruptOperationalHealth(dir)).rejects.toThrow(/source identity changed/);
      expect(await fs.readFile(sourcePath, 'utf8')).toBe('{replacement-corrupt');
      expect(await fs.readdir(quarantineDir)).toEqual([]);
    } finally {
      chdir.mockRestore();
    }
  });

  it('rejects same-inode mutation after inspection instead of publishing a stale digest manifest', async () => {
    const dir = await tempDir();
    const sourcePath = path.join(dir, OPERATIONAL_HEALTH_FILENAME);
    const quarantineDir = path.join(dir, 'quarantine');
    await fs.writeFile(sourcePath, '{original-corrupt');
    const original = await fs.lstat(sourcePath, { bigint: true });
    const realChdir = process.chdir.bind(process);
    const chdir = vi.spyOn(process, 'chdir').mockImplementation((target) => {
      if (target === quarantineDir) writeFileSync(sourcePath, '{same-inode-mutated-corrupt');
      realChdir(target);
    });
    try {
      await expect(quarantineCorruptOperationalHealth(dir)).rejects.toThrow(/source identity changed/);
      const after = await fs.lstat(sourcePath, { bigint: true });
      expect(after.ino).toBe(original.ino);
      expect(await fs.readFile(sourcePath, 'utf8')).toBe('{same-inode-mutated-corrupt');
      expect(await fs.readdir(quarantineDir)).toEqual([]);
    } finally {
      chdir.mockRestore();
    }
  });

  it('refuses a symlinked quarantine directory without touching its target', async () => {
    const dir = await tempDir();
    const outside = await tempDir();
    await fs.writeFile(path.join(dir, OPERATIONAL_HEALTH_FILENAME), '{bad');
    await fs.symlink(outside, path.join(dir, 'quarantine'));
    await expect(quarantineCorruptOperationalHealth(dir)).rejects.toThrow(/not a real directory/);
    expect(await fs.readdir(outside)).toEqual([]);
    expect(await fs.readFile(path.join(dir, OPERATIONAL_HEALTH_FILENAME), 'utf8')).toBe('{bad');
  });

  it('pins the checked quarantine directory inode and refuses a raced symlink before writing evidence', async () => {
    const dir = await tempDir();
    const outside = await tempDir();
    const quarantineDir = path.join(dir, 'quarantine');
    const movedQuarantine = path.join(dir, 'quarantine-original');
    await fs.writeFile(path.join(dir, OPERATIONAL_HEALTH_FILENAME), '{bad');
    await fs.mkdir(quarantineDir);
    const realChdir = process.chdir.bind(process);
    const chdir = vi.spyOn(process, 'chdir').mockImplementation((target) => {
      if (target === quarantineDir) {
        renameSync(quarantineDir, movedQuarantine);
        symlinkSync(outside, quarantineDir);
      }
      realChdir(target);
    });
    try {
      await expect(quarantineCorruptOperationalHealth(dir)).rejects.toThrow(/quarantine path changed/);
      expect(await fs.readdir(outside)).toEqual([]);
      expect(await fs.readdir(movedQuarantine)).toEqual([]);
      expect(await fs.readFile(path.join(dir, OPERATIONAL_HEALTH_FILENAME), 'utf8')).toBe('{bad');
    } finally {
      chdir.mockRestore();
    }
  });

  it('doctor --fix --yes reports the move and recollects missing health without rebuilding it', async () => {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, OPERATIONAL_HEALTH_FILENAME), '{bad');
    const lines: string[] = [];
    await runDoctorCommand(config(dir), {
      fix: true,
      confirmed: true,
      adapters: [],
      connectControl: unreachable,
      log: (line) => lines.push(line),
    });
    expect(lines.some((line) => line.startsWith('fix: quarantined '))).toBe(true);
    await expect(fs.stat(path.join(dir, OPERATIONAL_HEALTH_FILENAME))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses symlink evidence without moving it or chmodding its external target', async () => {
    const dir = await tempDir();
    const outside = path.join(await tempDir(), 'outside-health');
    await fs.writeFile(outside, '{external-corrupt}', { mode: 0o644 });
    await fs.chmod(outside, 0o644);
    const sourcePath = path.join(dir, OPERATIONAL_HEALTH_FILENAME);
    await fs.symlink(outside, sourcePath);

    await expect(quarantineCorruptOperationalHealth(dir)).rejects.toThrow(/opened safely|unconfirmed corruption/);
    expect(await fs.readlink(sourcePath)).toBe(outside);
    expect(await fs.readFile(outside, 'utf8')).toBe('{external-corrupt}');
    if (process.platform !== 'win32') expect((await fs.stat(outside)).mode & 0o777).toBe(0o644);
  });

  it('refuses fix while the daemon ownership lease is held', async () => {
    const dir = await tempDir();
    const sourcePath = path.join(dir, OPERATIONAL_HEALTH_FILENAME);
    await fs.writeFile(sourcePath, '{bad');
    const lease = await acquireDaemonOwner(dir, 'daemon');
    try {
      await expect(quarantineCorruptOperationalHealth(dir)).rejects.toBeInstanceOf(DaemonOwnerActiveError);
      expect(await fs.readFile(sourcePath, 'utf8')).toBe('{bad');
    } finally {
      await lease.release();
    }
  });

  it('recovers an owner record whose live PID has a different process-start identity', async () => {
    const dir = await tempDir();
    await fs.writeFile(
      path.join(dir, DAEMON_OWNER_FILENAME),
      `${JSON.stringify({
        version: 2,
        pid: process.pid,
        nonce: '00000000-0000-4000-8000-000000000000',
        role: 'daemon',
        acquiredAt: '2026-08-09T00:00:00.000Z',
        processStartedAt: '2000-01-01T00:00:00.000Z',
        livenessPort: 1,
      })}\n`,
    );
    const lease = await acquireDaemonOwner(dir, 'doctor');
    await lease.release();
  });

  it('does not accept an owner record without process-start identity as a compatibility authority', async () => {
    const dir = await tempDir();
    await fs.writeFile(
      path.join(dir, DAEMON_OWNER_FILENAME),
      `${JSON.stringify({
        version: 2,
        pid: process.pid,
        nonce: '00000000-0000-4000-8000-000000000000',
        role: 'daemon',
        acquiredAt: '2026-08-09T00:00:00.000Z',
        livenessPort: 1,
      })}\n`,
    );
    const lease = await acquireDaemonOwner(dir, 'doctor');
    await lease.release();
  });

  it('reclaims an owner record after its PID was reused by an unrelated live process', async () => {
    const dir = await tempDir();
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    if (child.pid === undefined) throw new Error('test child did not start');
    try {
      await fs.writeFile(
        path.join(dir, DAEMON_OWNER_FILENAME),
        `${JSON.stringify({
          version: 2,
          pid: child.pid,
          nonce: '00000000-0000-4000-8000-000000000000',
          role: 'daemon',
          acquiredAt: '2026-08-09T00:00:00.000Z',
          processStartedAt: '2000-01-01T00:00:00.000Z',
          livenessPort: await unusedLoopbackPort(),
        })}\n`,
      );
      const lease = await acquireDaemonOwner(dir, 'doctor');
      await lease.release();
    } finally {
      child.kill();
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      }
    }
  });

  it('recovers a stale malformed reclaim marker after its bounded grace period', async () => {
    const dir = await tempDir();
    const reclaimPath = path.join(dir, `${DAEMON_OWNER_FILENAME}.reclaim`);
    await fs.writeFile(reclaimPath, '');
    const stale = new Date(Date.now() - 60_000);
    await fs.utimes(reclaimPath, stale, stale);
    const lease = await acquireDaemonOwner(dir, 'doctor');
    await lease.release();
    await expect(fs.stat(reclaimPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('admits only one concurrent stale-owner reclaimer', async () => {
    const dir = await tempDir();
    await fs.writeFile(
      path.join(dir, DAEMON_OWNER_FILENAME),
      `${JSON.stringify({
        version: 2,
        pid: 999_999_999,
        nonce: '00000000-0000-4000-8000-000000000000',
        role: 'daemon',
        acquiredAt: '2026-08-09T00:00:00.000Z',
        processStartedAt: '2000-01-01T00:00:00.000Z',
        livenessPort: 1,
      })}\n`,
    );

    const contenders = await Promise.allSettled([
      acquireDaemonOwner(dir, 'doctor'),
      acquireDaemonOwner(dir, 'doctor'),
    ]);
    const winners = contenders.filter(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireDaemonOwner>>> => result.status === 'fulfilled',
    );
    const losers = contenders.filter((result) => result.status === 'rejected');
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as PromiseRejectedResult).reason).toBeInstanceOf(DaemonOwnerActiveError);
    await winners[0]!.value.release();
  });

  it.skipIf(process.platform === 'win32')('fails closed without blocking when the owner path is a FIFO', async () => {
    const dir = await tempDir();
    const ownerPath = path.join(dir, DAEMON_OWNER_FILENAME);
    execFileSync('mkfifo', [ownerPath]);
    const started = Date.now();
    await expect(acquireDaemonOwner(dir, 'doctor')).rejects.toThrow(/not a real regular file/);
    expect(Date.now() - started).toBeLessThan(1_000);
    await fs.rm(ownerPath);
    const lease = await acquireDaemonOwner(dir, 'doctor');
    await lease.release();
  });

  it('does not treat a stale bare-PID reclaim marker as an alternate live-owner authority', async () => {
    const dir = await tempDir();
    const reclaimPath = path.join(dir, `${DAEMON_OWNER_FILENAME}.reclaim`);
    await fs.writeFile(reclaimPath, `${process.pid}\n`);
    const stale = new Date(Date.now() - 60_000);
    await fs.utimes(reclaimPath, stale, stale);
    const lease = await acquireDaemonOwner(dir, 'doctor');
    await lease.release();
    await expect(fs.stat(reclaimPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
