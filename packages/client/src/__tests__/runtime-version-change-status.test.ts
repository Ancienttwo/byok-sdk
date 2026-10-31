import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import { connectControlClient } from '../daemon/control-client';
import type { ControlStatusResult } from '../daemon/control-protocol';
import { runStatusCommand } from '../bin/commands/status';
import { runDoctorCommand } from '../bin/commands/doctor';
import { createSupportBundle } from '../diagnostics/support-bundle';
import { createAuditAppender, readAuditRecords } from '../daemon/audit-log';
import { createDaemonRecordProjector } from '../daemon/daemon-record';
import type { DaemonEvent } from '../daemon/observer';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';
import { testScratchRoot } from './fixtures/execution-scratch';
import { waitForDaemonOpen } from './fixtures/lifecycle-barrier';

const dirs: string[] = [];
async function directory(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-runtime-change-'));
  dirs.push(dir);
  return dir;
}

/**
 * #1103 §2.6: an upgrade and a downgrade are both local notices. This drives
 * two real daemon starts over one store, so the comparison crosses an actual
 * restart, then reads every local surface and proves the audit/support sinks
 * do not gain the version text.
 */
describe('#1103 restart version change notices', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  beforeEach(async () => { server = await TestServer.start(); });
  afterEach(async () => {
    vi.restoreAllMocks();
    await daemon?.stop();
    daemon = undefined;
    await server.close();
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function startVersion(input: {
    storeDir: string;
    version: string;
    paired: boolean;
    events?: DaemonEvent[];
    appender?: ReturnType<typeof createAuditAppender>;
    projector?: ReturnType<typeof createDaemonRecordProjector>;
  }): Promise<Daemon> {
    const config: DaemonConfig = {
      storage: { scratchRoot: testScratchRoot() },
      localAgentRelease: { version: '0.0.0-test' },
      productName: 'Runtime Change',
      productId: 'runtime-change',
      serverUrl: server.url,
      storeDir: input.storeDir,
    };
    const started = createDaemonWithAdapters(config, [
      new StubRuntimeAdapter('pi', {
        kind: 'available', version: input.version,
        versionVerdict: { state: 'allow', qualifiedVersion: '1.0.0' },
      }),
    ]);
    if (input.events !== undefined && input.appender !== undefined && input.projector !== undefined) {
      started.subscribe((event) => {
        input.events!.push(event);
        for (const record of input.projector!.project(event)) input.appender!.append(record);
      });
    }
    if (!input.paired) await started.pair('pairing-code');
    await started.start();
    await waitForDaemonOpen(started);
    return started;
  }

  it('reports an upgrade on status, doctor and stderr across a restart, and keeps it out of audit and support bundles', async () => {
    const storeDir = await directory();
    const config: DaemonConfig = {
      storage: { scratchRoot: testScratchRoot() },
      localAgentRelease: { version: '0.0.0-test' }, productName: 'Runtime Change', productId: 'runtime-change',
      serverUrl: server.url, storeDir,
    };
    daemon = await startVersion({ storeDir, version: '1.0.0', paired: false });
    expect(daemon.status().runtimes[0]?.versionChange).toBeUndefined();
    expect(JSON.parse(await fs.readFile(path.join(storeDir, 'runtime-versions.json'), 'utf8')).runtimes.pi.version).toBe('1.0.0');
    await daemon.stop();
    daemon = undefined;

    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((message: unknown) => { warnings.push(String(message)); });
    const events: DaemonEvent[] = [];
    const appender = createAuditAppender(storeDir);
    const projector = createDaemonRecordProjector();
    daemon = await startVersion({ storeDir, version: '1.1.0', paired: true, events, appender, projector });

    const expected = {
      fromVersion: '1.0.0', toVersion: '1.1.0', direction: 'upgrade' as const,
      observedAt: expect.any(String),
    };
    expect(daemon.status().runtimes[0]?.versionChange).toEqual(expected);
    expect(warnings.some((line) => line.includes('runtime pi version upgrade: 1.0.0 -> 1.1.0'))).toBe(true);

    const connection = await connectControlClient({ storeDir, productId: config.productId });
    if (!connection.ok) throw new Error('expected an online daemon');
    try {
      const live = await connection.client.request<ControlStatusResult>('status');
      expect(JSON.stringify(live.runtimes)).not.toContain('versionChange');
      expect(live.runtimeVersionChanges).toEqual([{ id: 'pi', versionChange: expected }]);
    } finally {
      connection.client.close();
    }

    const statusLines: string[] = [];
    await runStatusCommand(config, { log: (line) => statusLines.push(line) });
    expect(statusLines.some((line) => line.includes('pi=available:versionChange=upgrade(1.0.0->1.1.0)'))).toBe(true);

    const doctorText: string[] = [];
    await runDoctorCommand(config, { log: (line) => doctorText.push(line) });
    const changeLine = doctorText.find((line) => line.startsWith('runtime-version-change:'));
    expect(changeLine).toContain('direction=upgrade');
    expect(changeLine).toContain('from=1.0.0');
    expect(changeLine).toContain('to=1.1.0');

    const doctorJson: string[] = [];
    await runDoctorCommand(config, { json: true, log: (line) => doctorJson.push(line) });
    const parsed = JSON.parse(doctorJson.join('')) as { diagnostics: { runtimes: Array<{ versionChange?: unknown }> } };
    expect(parsed.diagnostics.runtimes[0]?.versionChange).toEqual(expected);

    const bundle = await createSupportBundle(config, storeDir);
    expect(JSON.stringify(bundle)).not.toContain('versionChange');

    await appender.flush();
    const records = await readAuditRecords(storeDir);
    const detected = records.find((record) => record.kind === 'runtimes-detected');
    if (detected?.kind !== 'runtimes-detected') throw new Error('expected a runtimes-detected record');
    expect(JSON.stringify(detected)).not.toContain('versionChange');
    expect(JSON.stringify(detected)).not.toContain('1.1.0');
    expect(events.some((event) => event.kind === 'runtimes-detected')).toBe(true);
  });

  it('uses stronger wording for a downgrade, even when the version policy still allows it', async () => {
    const storeDir = await directory();
    daemon = await startVersion({ storeDir, version: '1.1.0', paired: false });
    await daemon.stop();
    daemon = undefined;

    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((message: unknown) => { warnings.push(String(message)); });
    daemon = await startVersion({ storeDir, version: '1.0.0', paired: true });

    expect(daemon.status().runtimes[0]?.versionChange?.direction).toBe('downgrade');
    expect(warnings.some((line) => line.includes('runtime pi version DOWNGRADED: 1.1.0 -> 1.0.0'))).toBe(true);
    expect(warnings.some((line) => line.includes('may have been replaced'))).toBe(true);

    const doctorText: string[] = [];
    await runDoctorCommand(configFor(server.url, storeDir), { log: (line) => doctorText.push(line) });
    const changeLine = doctorText.find((line) => line.startsWith('runtime-version-change:'));
    expect(changeLine).toContain('direction=downgrade');
    expect(changeLine).toContain('the installed CLI may have been replaced');
  });
});

function configFor(serverUrl: string, storeDir: string): DaemonConfig {
  return {
    storage: { scratchRoot: testScratchRoot() },
    localAgentRelease: { version: '0.0.0-test' }, productName: 'Runtime Change', productId: 'runtime-change',
    serverUrl, storeDir,
  };
}
