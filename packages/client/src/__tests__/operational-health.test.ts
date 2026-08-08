import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OperationalHealthTracker } from '../daemon/operational-health';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-health-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
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
});
