import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_OPERATIONAL_HEALTH_FILE_BYTES, OperationalHealthTracker } from '../daemon/operational-health';
import type { Runner } from '../util/exec-runner';
import { SecureDirHardeningError } from '../util/secure-dir';

// Route the tracker's ensureSecureStoreRoot through the win32 icacls branch with a
// fake runner so the hardening count is observable on any host OS.
const icacls = vi.hoisted(() => ({ run: undefined as Runner | undefined }));
vi.mock('../util/secure-dir', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../util/secure-dir')>();
  return {
    ...actual,
    ensureSecureStoreRoot: (dir: string) =>
      icacls.run ? actual.ensureSecureStoreRoot(dir, { platform: 'win32', run: icacls.run }) : actual.ensureSecureStoreRoot(dir),
  };
});

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-health-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  icacls.run = undefined;
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('operational health', () => {
  it('degrades at three failures in 60s and requires a recovering step before healthy', async () => {
    const dir = await tempDir();
    let now = new Date('2026-08-09T00:00:00.000Z');
    const tracker = new OperationalHealthTracker(dir, { clock: () => now, runId: () => 'run-1', pid: 123 });
    await tracker.startRun();
    await tracker.recordFailure('reconnect');
    await tracker.recordFailure('upload');
    await tracker.recordFailure('maintenance');
    expect(tracker.snapshot()).toMatchObject({ availability: 'available', state: 'degraded', failureCount: 3 });

    await tracker.recordSuccess('reconnect');
    expect(tracker.snapshot()).toMatchObject({ availability: 'available', state: 'recovering' });
    now = new Date('2026-08-09T00:01:01.000Z');
    await tracker.recordSuccess('reconnect');
    expect(tracker.snapshot()).toMatchObject({ availability: 'available', state: 'healthy', failureCount: 0 });
  });

  it('discards future-dated failures after a wall-clock rollback instead of extending the window', async () => {
    const dir = await tempDir();
    let now = new Date('2026-08-09T01:00:00.000Z');
    const first = new OperationalHealthTracker(dir, { clock: () => now, runId: () => 'run-1', pid: 1 });
    await first.startRun();
    await first.recordFailure('reconnect');
    await first.recordFailure('upload');
    await first.recordFailure('maintenance');
    expect(first.snapshot()).toMatchObject({ availability: 'available', state: 'degraded', failureCount: 3 });
    await first.markCleanStop();

    now = new Date('2026-08-09T00:00:00.000Z');
    const afterRollback = new OperationalHealthTracker(dir, { clock: () => now, runId: () => 'run-2', pid: 2 });
    await afterRollback.startRun();
    expect(afterRollback.snapshot()).toMatchObject({ availability: 'available', state: 'degraded', failureCount: 0 });
    await afterRollback.recordSuccess('reconnect');
    expect(afterRollback.snapshot()).toMatchObject({ availability: 'available', state: 'healthy', failureCount: 0 });
  });

  it('writes a control endpoint refusal noted before startRun, and without one the file bytes are unchanged', async () => {
    const dir = await tempDir();
    const now = new Date('2026-08-09T00:00:00.000Z');
    const tracker = new OperationalHealthTracker(dir, { clock: () => now, runId: () => 'run-1', pid: 123 });
    await tracker.noteControlEndpoint({ code: 'private_dir_symlink', path: '/tmp/byok-0123456789abcdef' });
    await tracker.startRun();
    const filePath = path.join(dir, 'operational-health.json');
    expect(JSON.parse(await fs.readFile(filePath, 'utf8')).controlEndpoint).toEqual({
      status: 'refused', code: 'private_dir_symlink', path: '/tmp/byok-0123456789abcdef', at: now.toISOString(),
    });

    await tracker.noteControlEndpoint(undefined);
    expect(await fs.readFile(filePath, 'utf8')).toBe(JSON.stringify({
      version: 1,
      state: 'healthy',
      failures: [],
      crashes: [],
      currentRun: { id: 'run-1', startedAt: now.toISOString(), pid: 123 },
    }, null, 2));
  });

  it('records an unclean previous run, but never classifies a clean stop as a crash', async () => {
    const dir = await tempDir();
    let now = new Date('2026-08-09T00:00:00.000Z');
    const first = new OperationalHealthTracker(dir, { clock: () => now, runId: () => 'run-1', pid: 1 });
    await first.startRun();

    now = new Date('2026-08-09T00:00:10.000Z');
    const second = new OperationalHealthTracker(dir, { clock: () => now, runId: () => 'run-2', pid: 2 });
    await second.startRun();
    expect(second.snapshot()).toMatchObject({ availability: 'available', crashCount: 1, lastCrashAt: now.toISOString() });
    await second.markCleanStop();

    now = new Date('2026-08-09T00:00:20.000Z');
    const third = new OperationalHealthTracker(dir, { clock: () => now, runId: () => 'run-3', pid: 3 });
    await third.startRun();
    expect(third.snapshot()).toMatchObject({ availability: 'available', crashCount: 1 });
  });

  it('bounds shape-valid histories at the load boundary even without a new failure or crash', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'operational-health.json');
    const failures = Array.from({ length: 8 }, (_, index) => ({
      at: `2026-08-09T00:00:0${index}.000Z`,
      source: 'reconnect',
    }));
    const crashes = Array.from({ length: 8 }, (_, index) => ({
      detectedAt: `2026-08-09T00:00:0${index}.000Z`,
      previousRunStartedAt: `2026-08-08T23:59:0${index}.000Z`,
    }));
    await fs.writeFile(file, JSON.stringify({ version: 1, state: 'healthy', failures, crashes }), 'utf8');

    const tracker = new OperationalHealthTracker(dir, {
      clock: () => new Date('2026-08-09T00:00:08.000Z'),
      runId: () => 'bounded-run',
      maxFailures: 3,
      maxCrashes: 2,
    });
    await tracker.startRun();
    expect(tracker.snapshot()).toMatchObject({ availability: 'available', state: 'degraded', failureCount: 3, crashCount: 2 });
    const persisted = JSON.parse(await fs.readFile(file, 'utf8')) as { failures: unknown[]; crashes: unknown[] };
    expect(persisted.failures).toHaveLength(3);
    expect(persisted.crashes).toHaveLength(2);
  });

  it('rejects an oversized state at the same bounded read authority doctor uses', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'operational-health.json');
    await fs.writeFile(file, JSON.stringify({ version: 1, state: 'healthy', failures: [], crashes: [] }));
    await fs.truncate(file, MAX_OPERATIONAL_HEALTH_FILE_BYTES + 1);
    const tracker = new OperationalHealthTracker(dir);
    await tracker.startRun();
    expect(tracker.snapshot()).toMatchObject({
      availability: 'unavailable',
      reason: 'operational health state exceeds the 1 MiB read limit; corruption is unconfirmed',
    });
    expect((await fs.stat(file)).size).toBe(MAX_OPERATIONAL_HEALTH_FILE_BYTES + 1);
  });

  it('rejects unknown top-level fields instead of silently treating them as canonical health state', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'operational-health.json');
    await fs.writeFile(
      file,
      JSON.stringify({ version: 1, state: 'healthy', failures: [], crashes: [], padding: 'not-canonical' }),
    );
    const tracker = new OperationalHealthTracker(dir);
    await tracker.startRun();
    expect(tracker.snapshot()).toEqual({ availability: 'unavailable', reason: 'operational health state has an invalid shape' });
  });

  it('reports corrupt state as unavailable without deleting or rebuilding it', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'operational-health.json');
    await fs.writeFile(file, '{not-json', 'utf8');
    const tracker = new OperationalHealthTracker(dir);
    await tracker.startRun();
    expect(tracker.snapshot()).toEqual({ availability: 'unavailable', reason: 'operational health state is corrupt JSON' });
    await tracker.recordFailure('lifecycle');
    await tracker.markCleanStop();
    expect(await fs.readFile(file, 'utf8')).toBe('{not-json');
  });

  it('hardens storeDir with icacls once per tracker, not on every state write', async () => {
    const dir = await tempDir();
    const run = vi.fn<Runner>().mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    icacls.run = run;
    const tracker = new OperationalHealthTracker(dir);
    await tracker.startRun();
    await tracker.recordFailure('reconnect');
    await tracker.recordFailure('upload');
    await tracker.recordFailure('maintenance');
    await tracker.recordSuccess('reconnect');
    await tracker.markCleanStop();
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('icacls', expect.arrayContaining([dir, '/inheritance:r']));
  });

  it('fails the write closed when the first hardening fails and never writes unhardened state', async () => {
    const dir = await tempDir();
    icacls.run = vi.fn<Runner>().mockResolvedValue({ code: 5, stdout: '', stderr: 'Access is denied.' });
    const tracker = new OperationalHealthTracker(dir);
    await expect(tracker.startRun()).rejects.toBeInstanceOf(SecureDirHardeningError);
    await expect(fs.stat(path.join(dir, 'operational-health.json'))).rejects.toThrow();
    expect(tracker.snapshot()).toEqual({ availability: 'unavailable', reason: 'operational health state could not be persisted' });
  });
});
