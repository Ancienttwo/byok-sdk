import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createDaemonWithAdapters } from '../daemon/create-daemon';
import type { DaemonEvent } from '../daemon/observer';
import type { ControlStatusResult } from '../daemon/control-protocol';
import { connectControlClient } from '../bin/control-client';
import { createAuditAppender, readAuditRecords, readLastEnvironmentRecord } from '../bin/audit-log';
import { runStatusCommand } from '../bin/commands/status';
import { collectDiagnostics } from '../diagnostics/diagnostics';
import { createSupportBundle } from '../diagnostics/support-bundle';
import * as runtimeProbe from '../bin/runtime-probe';
import * as serviceEnvironment from '../login-shell-environment';
import { createDaemonRecordProjector } from '../daemon/daemon-record';
import { parseRuntimeObservations } from '../runtime-detection';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';
import { waitForDaemonOpen } from './fixtures/lifecycle-barrier';

describe('#392: daemon startup observations are the live authority', () => {
  it('emits the environment event, caches failed detections too, and serves status/doctor/bundle without local probes', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-obs-'));
    const server = await TestServer.start();
    const config = { localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme', productId: 'obs-392', serverUrl: server.url, storeDir: dir };
    const adapters = [new StubRuntimeAdapter('pi'), new StubRuntimeAdapter('claude', { kind: 'not-found' })];
    const detects = adapters.map(adapter => vi.spyOn(adapter, 'detect'));
    const environment = { source: 'login-shell' as const, shell: 'fish', durationMs: 12 };
    vi.spyOn(serviceEnvironment, 'serviceEnvironmentStatus').mockReturnValue(environment);
    const daemon = createDaemonWithAdapters(config, adapters);
    const events: DaemonEvent[] = [];
    const appender = createAuditAppender(dir);
    const projector = createDaemonRecordProjector();
    const unsubscribe = daemon.subscribe(event => { events.push(event); for (const record of projector.project(event)) appender.append(record); });
    const probe = vi.spyOn(runtimeProbe, 'probeRuntimes').mockRejectedValue(new Error('must not probe locally'));
    try {
      await daemon.pair('pairing-code');
      await daemon.start();
      await waitForDaemonOpen(daemon);
      await appender.flush();
      const resolved = events.find(event => event.kind === 'environment-resolved');
      expect(resolved).toEqual({ kind: 'environment-resolved', ts: expect.any(String), status: environment });
      expect(events.findIndex(event => event.kind === 'environment-resolved')).toBeLessThan(events.findIndex(event => event.kind === 'runtimes-detected'));
      const expected = [
        { id: 'pi', present: true, outcome: 'available', version: '0.0.0', steer: true, resume: true },
        { id: 'claude', present: false, outcome: 'not-found', steer: true, resume: true },
      ];
      const status = daemon.status();
      expect(status.runtimes).toEqual(expected);
      expect(status.environment).toEqual(environment);
      expect(status.environmentResolvedAt).toBe(resolved?.ts);
      // Callers must not mutate the cache through the synchronous API.
      status.runtimes.splice(0);
      status.environment.source = 'inherited';
      expect(daemon.status().runtimes).toEqual(expected);
      expect(daemon.status().environment).toEqual(environment);
      const connection = await connectControlClient({ storeDir: dir, productId: config.productId });
      if (!connection.ok) throw new Error('expected online daemon');
      try {
        const live = await connection.client.request<ControlStatusResult>('status');
        expect(live.runtimes).toEqual(expected);
        expect(live.environment).toEqual(environment);
        expect(live.environmentResolvedAt).toBe(resolved?.ts);
      } finally { connection.client.close(); }
      const lines: string[] = [];
      await runStatusCommand(config, { log: line => lines.push(line) });
      expect(lines).toContain('live-runtimes: pi=available claude=not-found');
      expect(lines).toContain('live-environment: login-shell shell=fish durationMs=12');
      const snapshot = await collectDiagnostics(config, dir, { adapters });
      expect(snapshot.runtimeSource).toBe('daemon');
      expect(snapshot.runtimes.map(runtime => runtime.outcome)).toEqual(['available', 'not-found']);
      expect(snapshot.environment).toEqual({ ts: resolved?.ts, status: environment });
      const bundle = await createSupportBundle(config, dir, { adapters });
      expect(bundle.runtimeSource).toBe('daemon');
      expect(bundle.environment).toEqual(snapshot.environment);
      expect(probe).not.toHaveBeenCalled();
      for (const detect of detects) expect(detect).toHaveBeenCalledTimes(1);
      expect((await readAuditRecords(dir)).filter(record => record.kind === 'environment-resolved')).toEqual([{ kind: 'environment-resolved', ts: resolved?.ts, ...environment }]);
      expect(await readLastEnvironmentRecord(dir)).toEqual(snapshot.environment);
      await daemon.stop();
      await appender.flush();
      const offline: string[] = [];
      await runStatusCommand(config, { log: line => offline.push(line) });
      expect(offline.some(line => /^runtimes: last-known pi=available claude=not-found at=/.test(line))).toBe(true);
      expect(probe).not.toHaveBeenCalled();
    } finally {
      await daemon.stop();
      await appender.flush();
      unsubscribe();
      vi.restoreAllMocks();
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('a later start() reports no runtimes until its own detection finishes, never the previous start\'s', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-obs-restart-'));
    const server = await TestServer.start();
    const config = { localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme', productId: 'obs-392-restart', serverUrl: server.url, storeDir: dir };
    const adapter = new StubRuntimeAdapter('pi');
    const daemon = createDaemonWithAdapters(config, [adapter]);
    let releaseDetect: (() => void) | undefined;
    try {
      await daemon.pair('pairing-code');
      await daemon.start();
      await waitForDaemonOpen(daemon);
      expect(daemon.status().runtimes.map(runtime => runtime.outcome)).toEqual(['available']);
      await daemon.stop();

      const detectGate = new Promise<void>(resolve => { releaseDetect = resolve; });
      let detectStarted!: () => void;
      const detectEntered = new Promise<void>(resolve => { detectStarted = resolve; });
      vi.spyOn(adapter, 'detect').mockImplementation(async () => {
        detectStarted();
        await detectGate;
        return { kind: 'not-found' };
      });
      const restarted = daemon.start();
      await detectEntered;
      expect(daemon.status().runtimes).toEqual([]);
      releaseDetect!();
      await restarted;
      expect(daemon.status().runtimes.map(runtime => runtime.outcome)).toEqual(['not-found']);
    } finally {
      releaseDetect?.();
      await daemon.stop();
      vi.restoreAllMocks();
      await server.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects older/mixed runtime-id records instead of inventing available observations', () => {
    expect(parseRuntimeObservations([{ id: 'pi' }])).toBeUndefined();
    expect(parseRuntimeObservations([{ id: 'pi', present: true, outcome: 'not-found', steer: true, resume: true }])).toBeUndefined();
    expect(parseRuntimeObservations([{ id: 'pi', present: false, outcome: 'refused', reason: 'app_server_unavailable', steer: true, resume: true }])).toEqual([
      { id: 'pi', present: false, outcome: 'refused', reason: 'app_server_unavailable', steer: true, resume: true },
    ]);
  });
});
