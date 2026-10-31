import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDaemonWithAdapters, type Daemon, type DaemonConfig } from '../daemon/create-daemon';
import { connectControlClient } from '../daemon/control-client';
import type { ControlStatusResult } from '../daemon/control-protocol';
import {
  attachRuntimeVersionVerdicts, parseRuntimeObservations, projectRuntimeObservation, validateRuntimeDetectResult,
} from '../runtime-detection';
import { runStatusCommand } from '../bin/commands/status';
import { runDoctorCommand } from '../bin/commands/doctor';
import { formatRuntimeLines } from '../diagnostics/format';
import { collectDiagnostics } from '../diagnostics/diagnostics';
import { createSupportBundle } from '../diagnostics/support-bundle';
import { createAuditAppender, readAuditRecords } from '../daemon/audit-log';
import { createDaemonRecordProjector } from '../daemon/daemon-record';
import type { DaemonEvent } from '../daemon/observer';
import { freezeRuntimeAdapterDescriptor } from '../types';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';
import { waitForDaemonOpen } from './fixtures/lifecycle-barrier';

const ALLOW = { state: 'allow' as const, qualifiedVersion: '1.4.0' };
const WARN = { state: 'warn' as const, qualifiedVersion: '2.1.312' };
const BLOCK = { state: 'block' as const, qualifiedVersion: '0.160.0', matched: '0.16.' };

const adapters = () => [
  new StubRuntimeAdapter('pi', { kind: 'available', version: '1.4.0', versionVerdict: ALLOW }),
  new StubRuntimeAdapter('claude', {
    kind: 'available',
    version: '2.1.400',
    versionVerdict: WARN,
    advisory: { reason: 'runtime_version_unqualified', qualifiedVersion: '2.1.312' },
  }),
  new StubRuntimeAdapter('codex', { kind: 'available', version: 'codex-cli 0.161.0', versionVerdict: BLOCK }),
];

const dirs: string[] = [];
async function directory(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-verdict-status-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('#1103: version verdicts in local status and doctor', () => {
  let server: TestServer | undefined;
  let daemon: Daemon | undefined;
  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    await server?.close();
    server = undefined;
  });

  it('serves allow/warn/block through Daemon.status(), control status, doctor JSON/text and keeps them out of audit and support bundles', async () => {
    server = await TestServer.start();
    const dir = await directory();
    const config: DaemonConfig = {
      localAgentRelease: { version: '0.0.0-test' }, productName: 'Verdict', productId: 'verdict-status',
      serverUrl: server.url, storeDir: dir,
    };
    const runtimeAdapters = adapters();
    daemon = createDaemonWithAdapters(config, runtimeAdapters);
    const events: DaemonEvent[] = [];
    const appender = createAuditAppender(dir);
    const projector = createDaemonRecordProjector();
    const unsubscribe = daemon.subscribe((event) => { events.push(event); for (const record of projector.project(event)) appender.append(record); });
    try {
      await daemon.pair('pairing-code');
      await daemon.start();
      await waitForDaemonOpen(daemon);

      expect(daemon.status().runtimes.map(({ versionVerdict }) => versionVerdict)).toEqual([ALLOW, WARN, BLOCK]);

      const connection = await connectControlClient({ storeDir: dir, productId: config.productId });
      if (!connection.ok) throw new Error('expected an online daemon');
      try {
        const live = await connection.client.request<ControlStatusResult>('status');
        // The additive channel keeps `runtimes` parseable by a pre-#1103
        // client, which rejects an unknown key inside any observation.
        expect(JSON.stringify(live.runtimes)).not.toContain('versionVerdict');
        const observed = parseRuntimeObservations(live.runtimes);
        expect(observed?.map(({ versionVerdict }) => versionVerdict)).toEqual([undefined, undefined, undefined]);
        expect(live.runtimeVersionVerdicts).toEqual([
          { id: 'pi', versionVerdict: ALLOW },
          { id: 'claude', versionVerdict: WARN },
          { id: 'codex', versionVerdict: BLOCK },
        ]);
        expect(attachRuntimeVersionVerdicts(observed!, live.runtimeVersionVerdicts).map(({ versionVerdict }) => versionVerdict))
          .toEqual([ALLOW, WARN, BLOCK]);
      } finally {
        connection.client.close();
      }

      const statusLines: string[] = [];
      await runStatusCommand(config, { log: (line) => statusLines.push(line) });
      expect(statusLines).toContain('live-runtimes: pi=available claude=available codex=available:blocked');

      const snapshot = await collectDiagnostics(config, dir);
      expect(snapshot.runtimeSource).toBe('daemon');
      expect(snapshot.runtimes.map(({ versionVerdict }) => versionVerdict)).toEqual([ALLOW, WARN, BLOCK]);

      const doctorText: string[] = [];
      await runDoctorCommand(config, { log: (line) => doctorText.push(line) });
      const blockLine = doctorText.find((line) => line.includes('state=block'));
      expect(blockLine).toContain('runtime-version:');
      expect(blockLine).toContain('qualifiedVersion=0.160.0');
      expect(blockLine).toContain('matched=0.16.');
      expect(blockLine).toContain('blocked by the device version policy');

      const doctorJson: string[] = [];
      await runDoctorCommand(config, { json: true, log: (line) => doctorJson.push(line) });
      const parsed = JSON.parse(doctorJson.join('')) as { diagnostics: { runtimes: Array<{ versionVerdict?: unknown }> } };
      expect(parsed.diagnostics.runtimes.map(({ versionVerdict }) => versionVerdict)).toEqual([ALLOW, WARN, BLOCK]);

      const bundle = await createSupportBundle(config, dir);
      expect(JSON.stringify(bundle)).not.toContain('versionVerdict');
      expect(bundle.runtimes.map(({ outcome }) => outcome)).toEqual(['available', 'available', 'available']);

      await appender.flush();
      const records = await readAuditRecords(dir);
      const detected = records.find((record) => record.kind === 'runtimes-detected');
      if (detected?.kind !== 'runtimes-detected') throw new Error('expected a runtimes-detected record');
      expect(detected.runtimes.every((runtime) => !('versionVerdict' in runtime))).toBe(true);
      expect(JSON.stringify(detected)).not.toContain('versionVerdict');
      expect(events.some((event) => event.kind === 'runtimes-detected')).toBe(true);
    } finally {
      unsubscribe();
      await appender.flush();
    }
  });

  it('projects every state on the detailed runtimes lines and bounds the local block reason', () => {
    const descriptor = (id: string) => freezeRuntimeAdapterDescriptor({
      id, supportsDispatchSelection: false,
      capabilities: { steer: true, resume: true, approvalInteractive: false },
    });
    const observations = [
      projectRuntimeObservation(descriptor('pi'), {
        kind: 'available', version: '1.4.0', versionVerdict: ALLOW,
      }),
      projectRuntimeObservation(descriptor('claude'), {
        kind: 'available', version: '2.1.400', advisory: { reason: 'runtime_version_unqualified', qualifiedVersion: '2.1.312' },
        versionVerdict: WARN,
      }),
      projectRuntimeObservation(descriptor('codex'), {
        kind: 'available', version: 'codex-cli 0.161.0', versionVerdict: BLOCK,
      }),
    ];
    expect(formatRuntimeLines(observations)).toEqual([
      'pi: present version=1.4.0 versionVerdict=allow capabilities=steer,resume',
      'claude: present version=2.1.400 warning=unqualified-version(qualified=2.1.312) versionVerdict=warn capabilities=steer,resume',
      'codex: present version=codex-cli 0.161.0 versionVerdict=block blockedBy=device-version-policy(matched=0.16.,qualified=0.160.0) capabilities=steer,resume',
    ]);
  });
});

describe('#1103: additive runtime observation parsing', () => {
  it('keeps an old observation without a verdict byte-for-byte additive', () => {
    const old = { id: 'codex', present: true, outcome: 'available', version: '0.101.0', qualifiedVersion: '0.160.0', steer: true, resume: true };
    expect(parseRuntimeObservations([old])).toEqual([old]);
    expect(parseRuntimeObservations([{ id: 'pi', present: false, outcome: 'not-found', steer: true, resume: true }])).toEqual([
      { id: 'pi', present: false, outcome: 'not-found', steer: true, resume: true },
    ]);
  });

  it('accepts and copies a new verdict, including the block match', () => {
    const observed = { id: 'codex', present: true, outcome: 'available', version: 'codex-cli 0.161.0', versionVerdict: BLOCK, steer: true, resume: true };
    expect(parseRuntimeObservations([observed])).toEqual([observed]);
    const warned = {
      id: 'claude', present: true, outcome: 'available', version: '2.1.400', qualifiedVersion: '2.1.312',
      versionVerdict: WARN, steer: true, resume: true,
    };
    expect(parseRuntimeObservations([warned])).toEqual([warned]);
  });

  it('rejects malformed verdicts and does not infer allow from an absent one', () => {
    for (const value of [
      { id: 'codex', present: true, outcome: 'available', versionVerdict: { state: 'invented', qualifiedVersion: '0.160.0' }, steer: true, resume: true },
      { id: 'codex', present: true, outcome: 'available', versionVerdict: { state: 'block', qualifiedVersion: '0.160.0' }, steer: true, resume: true },
      { id: 'claude', present: true, outcome: 'available', versionVerdict: WARN, steer: true, resume: true },
      { id: 'codex', present: true, outcome: 'available', versionVerdict: { ...BLOCK, extra: true }, steer: true, resume: true },
      { id: 'codex', present: true, outcome: 'available', versionVerdict: { ...BLOCK, matched: 'x'.repeat(257) }, steer: true, resume: true },
    ]) expect(parseRuntimeObservations([value])).toBeUndefined();
  });

  it('treats an old daemon\'s missing verdict channel as unknown, never allow', () => {
    const old = [
      { id: 'codex', present: true, outcome: 'available' as const, version: '0.101.0', steer: true, resume: true },
    ];
    expect(parseRuntimeObservations(old)).toEqual(old);
    expect(attachRuntimeVersionVerdicts(old, undefined)).toEqual(old);
    expect(attachRuntimeVersionVerdicts(old, [{ id: 'codex', versionVerdict: { state: 'invented' } }])).toEqual(old);
    expect(attachRuntimeVersionVerdicts(old, [{ id: 'codex', versionVerdict: BLOCK, extra: true }])).toEqual(old);
  });

  it('keeps the detect-result warning/advisory invariant when a verdict is present', () => {
    expect(() => validateRuntimeDetectResult({ kind: 'available', versionVerdict: WARN })).toThrow();
    expect(() => validateRuntimeDetectResult({
      kind: 'available', versionVerdict: BLOCK,
      advisory: { reason: 'runtime_version_unqualified', qualifiedVersion: '0.160.0' },
    })).toThrow();
  });
});
