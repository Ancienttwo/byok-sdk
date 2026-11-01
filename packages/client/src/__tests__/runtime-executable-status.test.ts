import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import { connectControlClient } from '../daemon/control-client';
import type { ControlStatusResult } from '../daemon/control-protocol';
import { runStatusCommand } from '../bin/commands/status';
import { runDoctorCommand } from '../bin/commands/doctor';
import { createSupportBundle } from '../diagnostics/support-bundle';
import { formatRuntimeLines } from '../diagnostics/format';
import { createAuditAppender, readAuditRecords } from '../daemon/audit-log';
import { createDaemonRecordProjector } from '../daemon/daemon-record';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';
import { testScratchRoot } from './fixtures/execution-scratch';
import { waitForDaemonOpen } from './fixtures/lifecycle-barrier';

const dirs: string[] = [];
async function directory(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-runtime-executable-'));
  dirs.push(dir);
  return dir;
}

/** Contains a space, so the text output must quote it. */
const CLAUDE_PATH = path.resolve('/opt/Example User/bin/claude');

function adapters() {
  return [
    new StubRuntimeAdapter('claude', { kind: 'available', version: '2.1.0', executablePath: CLAUDE_PATH, executableSource: 'env' }),
    new StubRuntimeAdapter('codex', { kind: 'available', version: '0.160.0', executableSource: 'path' }),
    new StubRuntimeAdapter('grok', { kind: 'not-found' }),
  ];
}

/**
 * #1103 O10: the executable each runtime's detection ran is local evidence.
 * Daemon.status() carries it inline; control status carries it beside the
 * strict observation array; status and doctor print it; audit and the
 * support bundle never see it.
 */
describe('#1103 runtime executable on local status and doctor', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  beforeEach(async () => { server = await TestServer.start(); });
  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    await server.close();
    await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('reports path and source on every local surface and keeps both out of audit and support bundles', async () => {
    const storeDir = await directory();
    const config: DaemonConfig = {
      storage: { scratchRoot: testScratchRoot() },
      localAgentRelease: { version: '0.0.0-test' }, productName: 'Runtime Executable', productId: 'runtime-executable',
      serverUrl: server.url, storeDir,
    };
    const appender = createAuditAppender(storeDir);
    const projector = createDaemonRecordProjector();
    daemon = createDaemonWithAdapters(config, adapters());
    daemon.subscribe((event) => { for (const record of projector.project(event)) appender.append(record); });
    await daemon.pair('pairing-code');
    await daemon.start();
    await waitForDaemonOpen(daemon);

    const inline = daemon.status().runtimes;
    expect(inline.find((r) => r.id === 'claude')).toMatchObject({ executablePath: CLAUDE_PATH, executableSource: 'env' });
    expect(inline.find((r) => r.id === 'codex')).toMatchObject({ executableSource: 'path' });
    expect(inline.find((r) => r.id === 'codex')).not.toHaveProperty('executablePath');
    expect(inline.find((r) => r.id === 'grok')).not.toHaveProperty('executableSource');

    const connection = await connectControlClient({ storeDir, productId: config.productId });
    if (!connection.ok) throw new Error('expected an online daemon');
    try {
      const live = await connection.client.request<ControlStatusResult>('status');
      expect(JSON.stringify(live.runtimes)).not.toContain('executable');
      expect(live.runtimeExecutables).toEqual([
        { id: 'claude', executablePath: CLAUDE_PATH, executableSource: 'env' },
        { id: 'codex', executableSource: 'path' },
      ]);
    } finally {
      connection.client.close();
    }

    const statusLines: string[] = [];
    await runStatusCommand(config, { log: (line) => statusLines.push(line) });
    const live = statusLines.find((line) => line.startsWith('live-runtimes:'));
    expect(live).toContain(`claude=available:executable=env(${JSON.stringify(CLAUDE_PATH)})`);
    expect(live).toContain('codex=available:executable=path');
    expect(live).toContain('grok=not-found');
    expect(live).not.toContain('grok=not-found:executable');

    const doctorText: string[] = [];
    await runDoctorCommand(config, { log: (line) => doctorText.push(line) });
    const executableLines = doctorText.filter((line) => line.startsWith('runtime-executable:'));
    expect(executableLines).toHaveLength(2);
    expect(executableLines.some((line) => line.endsWith(`executable=env(${JSON.stringify(CLAUDE_PATH)})`))).toBe(true);
    expect(executableLines.some((line) => line.endsWith('executable=path'))).toBe(true);

    const doctorJson: string[] = [];
    await runDoctorCommand(config, { json: true, log: (line) => doctorJson.push(line) });
    const parsed = JSON.parse(doctorJson.join('')) as { diagnostics: { runtimes: Array<{ executablePath?: string; executableSource?: string }> } };
    expect(parsed.diagnostics.runtimes.map(({ executablePath, executableSource }) => ({ executablePath, executableSource }))).toEqual([
      { executablePath: CLAUDE_PATH, executableSource: 'env' },
      { executablePath: undefined, executableSource: 'path' },
      { executablePath: undefined, executableSource: undefined },
    ]);

    const bundle = await createSupportBundle(config, storeDir);
    expect(JSON.stringify(bundle)).not.toContain('executable');
    expect(JSON.stringify(bundle)).not.toContain('Example User');

    await appender.flush();
    const detected = (await readAuditRecords(storeDir)).find((record) => record.kind === 'runtimes-detected');
    if (detected?.kind !== 'runtimes-detected') throw new Error('expected a runtimes-detected record');
    expect(JSON.stringify(detected)).not.toContain('executable');
    expect(JSON.stringify(detected)).not.toContain('Example User');
  });

  it('the runtimes command prints the executable on each available runtime line', () => {
    expect(formatRuntimeLines([
      { id: 'claude', present: true, outcome: 'available', executablePath: CLAUDE_PATH, executableSource: 'env', steer: false, resume: false },
      { id: 'codex', present: true, outcome: 'available', executableSource: 'path', steer: false, resume: false },
    ])).toEqual([
      `claude: present executable=env(${JSON.stringify(CLAUDE_PATH)}) capabilities=(none)`,
      'codex: present executable=path capabilities=(none)',
    ]);
  });

  it('offline doctor reports the executable from its own local probe', async () => {
    const storeDir = await directory();
    const config: DaemonConfig = {
      storage: { scratchRoot: testScratchRoot() },
      localAgentRelease: { version: '0.0.0-test' }, productName: 'Runtime Executable', productId: 'runtime-executable',
      serverUrl: server.url, storeDir,
    };
    const doctorJson: string[] = [];
    await runDoctorCommand(config, { json: true, adapters: adapters(), log: (line) => doctorJson.push(line) });
    const parsed = JSON.parse(doctorJson.join('')) as { diagnostics: { runtimeSource: string; runtimes: Array<{ executablePath?: string; executableSource?: string }> } };
    expect(parsed.diagnostics.runtimeSource).toBe('local-shell');
    expect(parsed.diagnostics.runtimes[0]).toMatchObject({ executablePath: CLAUDE_PATH, executableSource: 'env' });
  });
});
