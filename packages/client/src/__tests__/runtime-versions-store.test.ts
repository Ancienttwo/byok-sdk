import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RUNTIME_VERSIONS_FILE,
  compareRuntimeVersionTokens,
  readRuntimeVersions,
  recordRuntimeVersionChanges,
  runtimeVersionsPath,
} from '../daemon/runtime-versions-store';
import type { RuntimeObservation } from '../runtime-detection';

const dirs: string[] = [];
async function directory(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-runtime-versions-'));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

const available = (id: string, version?: string): RuntimeObservation => ({
  id, present: true, outcome: 'available', ...(version === undefined ? {} : { version }), steer: false, resume: false,
});
const notFound = (id: string): RuntimeObservation => ({ id, present: false, outcome: 'not-found', steer: false, resume: false });
const at = (iso: string) => new Date(iso);

describe('#1103 restart version comparison', () => {
  it('classifies upgrade, downgrade, changed and unknown from the numeric core', () => {
    expect(compareRuntimeVersionTokens('1.4.0', '1.4.0')).toBeUndefined();
    expect(compareRuntimeVersionTokens('1.4.0', '1.5.0')).toBe('upgrade');
    expect(compareRuntimeVersionTokens('2.0.0', '1.9.9')).toBe('downgrade');
    expect(compareRuntimeVersionTokens('1.0.62', '1.0.62+meta')).toBe('changed');
    expect(compareRuntimeVersionTokens('0.22.2+2364.g0b10b9f', '0.22.2+2365.g0b10b9f')).toBe('changed');
    expect(compareRuntimeVersionTokens('nightly', '1.0.0')).toBe('unknown');
    expect(compareRuntimeVersionTokens('1.0.0', '1.0.0-beta')).toBe('changed');
  });

  it('records the first run without a notice and writes only the local version/timestamp file', async () => {
    const storeDir = await directory();
    const changes = await recordRuntimeVersionChanges({
      storeDir,
      observations: [available('pi', '1.4.0'), available('claude'), notFound('codex')],
      now: at('2026-10-31T00:00:00.000Z'),
    });
    expect(changes.size).toBe(0);
    const file = runtimeVersionsPath(storeDir);
    expect(file).toBe(path.join(storeDir, RUNTIME_VERSIONS_FILE));
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({
      schemaVersion: 1,
      runtimes: { pi: { version: '1.4.0', observedAt: '2026-10-31T00:00:00.000Z' } },
    });
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    // No path, auth, environment or command text is stored.
    expect(await fs.readFile(file, 'utf8')).not.toMatch(/path|auth|env|command|1\.4\.0-beta/);
  });

  it('reports an upgrade and a downgrade on the next run', async () => {
    const storeDir = await directory();
    await recordRuntimeVersionChanges({ storeDir, observations: [available('pi', '1.0.0')], now: at('2026-10-31T00:00:00.000Z') });
    const upgraded = await recordRuntimeVersionChanges({
      storeDir, observations: [available('pi', '1.1.0')], now: at('2026-10-31T01:00:00.000Z'),
    });
    expect(upgraded.get('pi')).toEqual({
      fromVersion: '1.0.0', toVersion: '1.1.0', direction: 'upgrade', observedAt: '2026-10-31T01:00:00.000Z',
    });
    const downgraded = await recordRuntimeVersionChanges({
      storeDir, observations: [available('pi', '0.9.0')], now: at('2026-10-31T02:00:00.000Z'),
    });
    expect(downgraded.get('pi')?.direction).toBe('downgrade');
    expect(downgraded.get('pi')?.fromVersion).toBe('1.1.0');
  });

  it('reports a changed build suffix and an unparseable side as unknown', async () => {
    const storeDir = await directory();
    await recordRuntimeVersionChanges({ storeDir, observations: [available('pi', '1.4.0+build.1')], now: at('2026-10-31T00:00:00.000Z') });
    const changed = await recordRuntimeVersionChanges({
      storeDir, observations: [available('pi', '1.4.0+build.2')], now: at('2026-10-31T01:00:00.000Z'),
    });
    expect(changed.get('pi')?.direction).toBe('changed');
    const unknown = await recordRuntimeVersionChanges({
      storeDir, observations: [available('pi', 'nightly')], now: at('2026-10-31T02:00:00.000Z'),
    });
    expect(unknown.get('pi')?.direction).toBe('unknown');
  });

  it('does not compare an unavailable runtime or one without a version, and drops stale entries', async () => {
    const storeDir = await directory();
    await recordRuntimeVersionChanges({ storeDir, observations: [available('pi', '1.0.0'), available('claude', '2.0.0')], now: at('2026-10-31T00:00:00.000Z') });
    const changes = await recordRuntimeVersionChanges({
      storeDir, observations: [notFound('pi'), available('claude')], now: at('2026-10-31T01:00:00.000Z'),
    });
    expect(changes.size).toBe(0);
    expect(JSON.parse(await fs.readFile(runtimeVersionsPath(storeDir), 'utf8')).runtimes).toEqual({});
  });

  it('ignores a corrupt baseline with one warning, then records this run as the new baseline', async () => {
    const storeDir = await directory();
    await fs.writeFile(runtimeVersionsPath(storeDir), '{ not json');
    const warnings: string[] = [];
    const changes = await recordRuntimeVersionChanges({
      storeDir, observations: [available('pi', '1.4.0')], now: at('2026-10-31T00:00:00.000Z'),
      onWarning: (message) => warnings.push(message),
    });
    expect(changes.size).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('corrupt');
    expect((await readRuntimeVersions(storeDir)).runtimes.pi?.version).toBe('1.4.0');
  });

  it('rejects a malformed stored shape instead of trusting a fabricated baseline', async () => {
    const storeDir = await directory();
    await fs.writeFile(runtimeVersionsPath(storeDir), JSON.stringify({
      schemaVersion: 1,
      runtimes: { pi: { version: '1.4.0' } },
    }));
    const warnings: string[] = [];
    expect((await readRuntimeVersions(storeDir, (message) => warnings.push(message))).runtimes).toEqual({});
    expect(warnings).toHaveLength(1);
  });
});
