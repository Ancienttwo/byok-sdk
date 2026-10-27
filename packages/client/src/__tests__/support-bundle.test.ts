import { freshTestAgentRef, testAgentHomeConfig } from './fixtures/test-agent';
import { createTestDeviceStore } from './fixtures/device-credentials';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { freezeRuntimeAdapterDescriptor, type DaemonConfig, type RuntimeAdapter } from '../index';
import type { ConnectControlResult } from '../bin/control-client';
import { runSupportBundleCommand } from '../bin/commands/support-bundle';
import { runDoctorCommand } from '../bin/commands/doctor';
import { appendAuditRecord, auditLogPath } from '../bin/audit-log';
import { DAEMON_RECORD_KINDS } from '../daemon/daemon-record';
import { unmeasuredRetentionSnapshot } from '../daemon/retention/sweeper';
import {
  createSupportBundle,
  MAX_SUPPORT_AUDIT_FACTS,
  MAX_SUPPORT_AUDIT_TAIL_BYTES,
  writeSupportBundle,
} from '../diagnostics/support-bundle';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';

// A sessionless v3 Agent offer is a fresh one in v4, and a fresh offer carries the egress policy.
const FRESH_OFFER = { session: { mode: 'fresh' as const }, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY };

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-support-bundle-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function unreachable(): Promise<ConnectControlResult> {
  return Promise.resolve({ ok: false, reason: 'SENTINEL_CONTROL_PATH_SECRET' });
}

function config(storeDir: string): DaemonConfig {
  return {
    localAgentRelease: { version: '0.0.0-test' },
    productName: 'SENTINEL_PRODUCT_NAME_SECRET',
    productId: 'SENTINEL_PRODUCT_ID',
    serverUrl: 'https://user:SENTINEL_URL_SECRET@example.invalid/private/path?token=SENTINEL_QUERY_SECRET',
    agentHome: testAgentHomeConfig(), agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },
    storeDir,
    runtimeAllowlist: ['SENTINEL_ALLOWLIST_SECRET'],
  };
}

describe('support bundle privacy and bounds', () => {
  it('uses DaemonRecord kinds for all recent facts and excludes removed progress and unknown kinds', async () => {
    const dir = await tempDir();
    const kinds = [...DAEMON_RECORD_KINDS, 'progress', 'future-record'];
    await fs.writeFile(auditLogPath(dir), kinds.map(kind => JSON.stringify({ kind, ts: '2026-10-14T00:00:00.000Z' })).join('\n') + '\n');
    const bundle = await createSupportBundle(config(dir), dir, { adapters: [], connectControl: unreachable });
    expect(bundle.recentEvents.facts.map(fact => fact.kind)).toEqual([...DAEMON_RECORD_KINDS]);
    for (const fact of bundle.recentEvents.facts) expect(DAEMON_RECORD_KINDS).toContain(fact.kind);
    for (const kind of ['device-assertion', 'runtime-disposal-failed', 'agent-memory-intent-integrity', 'environment-resolved']) {
      expect(bundle.recentEvents.facts.map(fact => fact.kind)).toContain(kind);
    }
  });

  it('allowlists facts and excludes config, device, audit, control and path sentinels byte-for-byte', async () => {
    const dir = await tempDir();
    const record = {
      deviceId: 'SENTINEL_DEVICE_ID',
      tenantId: 'SENTINEL_TENANT_ID',
      devicePublicKey: 'SENTINEL_PUBLIC_KEY',
    };
    await createTestDeviceStore(dir).save(record);
    await fs.appendFile(
      auditLogPath(dir),
      `${JSON.stringify({ kind: 'SENTINEL_AUDIT_KIND', ts: '2026-08-09T00:00:00.000Z', raw: 'SENTINEL_PROMPT_TOOL_BODY' })}\n` +
        `${JSON.stringify({ kind: 'turn', ts: '2026-08-09T00:00:01.000Z' })}\n`,
    );
    const quarantineDir = path.join(dir, 'quarantine');
    await fs.mkdir(quarantineDir);
    await fs.writeFile(path.join(quarantineDir, 'SENTINEL_QUARANTINE_FILENAME'), 'SENTINEL_QUARANTINE_BYTES');

    const bundle = await createSupportBundle(config(dir), dir, { adapters: [], connectControl: unreachable });
    const serialized = JSON.stringify(bundle);
    const doctorLines: string[] = [];
    await runDoctorCommand(config(dir), {
      json: true,
      adapters: [],
      connectControl: unreachable,
      log: (line) => doctorLines.push(line),
    });
    const doctorOutput = doctorLines.join('\n');

    for (const sentinel of [
      'SENTINEL_PRODUCT_ID',
      'SENTINEL_PRODUCT_NAME_SECRET',
      'SENTINEL_URL_SECRET',
      'SENTINEL_QUERY_SECRET',
      'SENTINEL_DEVICE_ID',
      'SENTINEL_ACCESS_TOKEN',
      'SENTINEL_PRIVATE_KEY',
      'SENTINEL_PUBLIC_KEY',
      'SENTINEL_PROMPT_TOOL_BODY',
      'SENTINEL_AUDIT_KIND',
      'SENTINEL_CONTROL_PATH_SECRET',
      'SENTINEL_QUARANTINE_FILENAME',
      'SENTINEL_QUARANTINE_BYTES',
      'SENTINEL_ALLOWLIST_SECRET',
    ]) {
      expect(serialized).not.toContain(sentinel);
      expect(doctorOutput).not.toContain(sentinel);
    }
    expect(bundle.recentEvents.facts).toEqual([{ kind: 'turn', ts: '2026-08-09T00:00:01.000Z' }]);
    expect(bundle.redaction.policy).toBe('allowlist-v1');
  });

  it('projects runtime identifiers and version output through a closed bounded shape', async () => {
    const dir = await tempDir();
    const runtime: RuntimeAdapter = {
      descriptor: freezeRuntimeAdapterDescriptor({
        id: 'SENTINEL_RUNTIME_ID',
        supportsDispatchSelection: false,
        capabilities: {
          steer: true,
          resume: false,
          approvalInteractive: false,
        },
      }),
      detect: async () => ({ kind: 'available', version: `SENTINEL_RUNTIME_VERSION\n${'x'.repeat(10_000)}`, authPresent: true }),
      prepare: async () => ({ kind: 'reject', reason: 'not used', retryable: false }),
    };
    const bundle = await createSupportBundle(config(dir), dir, { adapters: [runtime], connectControl: unreachable });
    const serialized = JSON.stringify(bundle);
    const doctorLines: string[] = [];
    await runDoctorCommand(config(dir), {
      json: true,
      adapters: [runtime],
      connectControl: unreachable,
      log: (line) => doctorLines.push(line),
    });
    expect(serialized).not.toContain('SENTINEL_RUNTIME_ID');
    expect(serialized).not.toContain('SENTINEL_RUNTIME_VERSION');
    expect(doctorLines.join('\n')).not.toContain('SENTINEL_RUNTIME');
    expect(bundle.runtimes).toMatchObject([{ present: true, versionPresent: true }]);
    expect(serialized.length).toBeLessThan(64 * 1024);
  });

  it('reads only a bounded audit tail and retains at most 200 facts', async () => {
    const dir = await tempDir();
    const lines = Array.from({ length: 2_000 }, (_, index) =>
      JSON.stringify({ kind: 'turn', ts: new Date(1_800_000_000_000 + index).toISOString(), padding: 'x'.repeat(200) }),
    );
    await fs.writeFile(auditLogPath(dir), `${lines.join('\n')}\n`);

    const bundle = await createSupportBundle(config(dir), dir, { adapters: [], connectControl: unreachable });

    expect(bundle.recentEvents.facts).toHaveLength(MAX_SUPPORT_AUDIT_FACTS);
    expect(bundle.recentEvents.sourceBytesRead).toBeLessThanOrEqual(MAX_SUPPORT_AUDIT_TAIL_BYTES);
    expect(bundle.recentEvents.sourceTruncated).toBe(true);
  });

  it('refuses an audit.jsonl symlink instead of reading the external target', async () => {
    const dir = await tempDir();
    const outsideDir = await tempDir();
    const outside = path.join(outsideDir, 'external-audit.jsonl');
    await fs.writeFile(outside, `${JSON.stringify({ kind: 'turn', ts: '2026-08-09T00:00:01.000Z' })}\n`);
    await fs.symlink(outside, auditLogPath(dir));

    const bundle = await createSupportBundle(config(dir), dir, { adapters: [], connectControl: unreachable });

    expect(bundle.recentEvents).toMatchObject({ status: 'unavailable', included: 0, facts: [] });
    expect(await fs.readFile(outside, 'utf8')).toContain('"kind":"turn"');
  });

  it('#394: carries the last lifecycle as closed enums only', async () => {
    const dir = await tempDir();
    const at = '2026-10-13T00:00:00.000Z';
    await appendAuditRecord(dir, { kind: 'lifecycle', ts: at, lifecycle: { phase: 'halted', reason: 'device_revoked', at } });

    const bundle = await createSupportBundle(config(dir), dir, { adapters: [], connectControl: unreachable });

    expect(bundle.lifecycle).toEqual({ status: 'known', source: 'audit', phase: 'halted', reason: 'device_revoked' });
    expect(bundle.checks).toContainEqual({ id: 'lifecycle', status: 'fail' });
  });

  it.skipIf(process.platform === 'win32')('does not block when audit.jsonl is a FIFO', async () => {
    const dir = await tempDir();
    execFileSync('mkfifo', [auditLogPath(dir)]);
    const started = Date.now();
    const bundle = await createSupportBundle(config(dir), dir, { adapters: [], connectControl: unreachable });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(bundle.recentEvents.status).toBe('unavailable');
  });

  it('atomically creates a 0600 artifact and refuses to overwrite it', async () => {
    const dir = await tempDir();
    const bundle = await createSupportBundle(config(dir), dir, { adapters: [], connectControl: unreachable });
    const outputPath = path.join(dir, 'support.json');

    await writeSupportBundle(outputPath, bundle);
    const first = await fs.readFile(outputPath, 'utf8');
    expect(JSON.parse(first)).toMatchObject({ version: 1, redaction: { policy: 'allowlist-v1' } });
    if (process.platform !== 'win32') expect((await fs.stat(outputPath)).mode & 0o777).toBe(0o600);
    await expect(writeSupportBundle(outputPath, bundle)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await fs.readFile(outputPath, 'utf8')).toBe(first);
  });

  it.skipIf(process.platform === 'win32')('does not chmod an operator-selected parent directory', async () => {
    const dir = await tempDir();
    const outputDir = path.join(dir, 'shared-output');
    await fs.mkdir(outputDir, { mode: 0o755 });
    await fs.chmod(outputDir, 0o755);
    const bundle = await createSupportBundle(config(dir), dir, { adapters: [], connectControl: unreachable });
    await writeSupportBundle(path.join(outputDir, 'support.json'), bundle);
    expect((await fs.stat(outputDir)).mode & 0o777).toBe(0o755);
  });

  it('hardens the unpublished inode with a Windows DACL before linking it into place', async () => {
    const dir = await tempDir();
    const bundle = await createSupportBundle(config(dir), dir, { adapters: [], connectControl: unreachable });
    const calls: string[][] = [];
    await writeSupportBundle(path.join(dir, 'windows-support.json'), bundle, {
      platform: 'win32',
      run: async (_command, args) => {
        calls.push(args);
        if (calls.length === 1) {
          expect(args[0]).toContain('.windows-support.json.');
          expect(await fs.readdir(args[0]!)).toEqual([]);
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('/inheritance:r');
    expect(calls[1]?.[0]).toContain('bundle.tmp');
    expect(await fs.stat(path.join(dir, 'windows-support.json'))).toBeDefined();
  });

  it('CLI writes the requested bundle and prints an explicit redaction summary', async () => {
    const dir = await tempDir();
    const outputPath = path.join(dir, 'cli-support.json');
    const lines: string[] = [];
    await runSupportBundleCommand(config(dir), {
      outputPath,
      adapters: [],
      connectControl: unreachable,
      log: (line) => lines.push(line),
    });
    expect(JSON.parse(await fs.readFile(outputPath, 'utf8'))).toMatchObject({ version: 1 });
    expect(lines.some((line) => line.startsWith('redaction policy: allowlist-v1'))).toBe(true);
  });
});


describe('outbound rejection diagnostics #397', () => {
  it('reports failed terminal count from SQLite without copying payload bytes', async () => {
    const { SqliteLocalTaskJournal } = await import('../daemon/journal/sqlite-journal');
    const { journalHash } = await import('../daemon/journal/journal');
    const { createEnvelope, encodeEnvelope } = await import('@byok-sdk/protocol');
    const dir = await tempDir();
    const journal = new SqliteLocalTaskJournal({ storeDir: dir });
    const offer = createEnvelope('task.offer', { agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'SECRET_PAYLOAD_BYTES' }, { taskId: 'rejected-task', seq: 1 });
    const bytes = encodeEnvelope(offer);
    await journal.appendEnvelope({ identity: { tenantId: 'tenant', productId: 'product', deviceId: 'device' },
      envelopeId: offer.id, seq: 1, taskId: 'rejected-task', bytes, bytesHash: journalHash(bytes), receivedAt: new Date().toISOString(), opensTask: true });
    const terminal = encodeEnvelope(createEnvelope('task.complete', { summary: 'SECRET_PAYLOAD_BYTES', sessionRef: 'session' }, { taskId: 'rejected-task' }));
    await journal.recordTerminal({ taskId: 'rejected-task', terminalType: 'complete', bytes: terminal, payloadHash: journalHash(terminal), truthState: 'pending', attempt: 1, recordedAt: new Date().toISOString() });
    await journal.rejectTerminal('rejected-task', journalHash(terminal), 'not_permitted');
    await journal.close();
    const bundle = await createSupportBundle(config(dir), dir, { adapters: [], connectControl: unreachable });
    expect(bundle.journal).toMatchObject({ status: 'present', failedTerminalCount: 1 });
    expect(JSON.stringify(bundle)).not.toContain('SECRET_PAYLOAD_BYTES');
  });

  it('projects rejection audit to tasks without retaining payload fields', async () => {
    const { appendAuditRecord, readAuditRecords } = await import('../bin/audit-log');
    const { deriveTasksFromRecords } = await import('../bin/tasks-view');
    const { formatTaskLine } = await import('../bin/format');
    const dir = await tempDir();
    const ts = new Date().toISOString();
    await appendAuditRecord(dir, { kind: 'offered', ts, taskId: 'task' });
    await appendAuditRecord(dir, {
      kind: 'outbound-rejected',
      ts,
      envelopeId: crypto.randomUUID(),
      type: 'task.complete',
      taskId: 'task',
      reason: 'limit_exceeded',
      terminal: true,
      taskState: 'Complete',
    });
    const records = await readAuditRecords(dir);
    expect(records.some((record) => record.kind === 'outbound-rejected' && record.reason === 'limit_exceeded')).toBe(true);
    expect(formatTaskLine(deriveTasksFromRecords(records)[0]!)).toContain('delivery=rejected');
  });
});


it('includes live outbound counters while excluding last-rejection identity and payload', async () => {
  const dir = await tempDir();
  const counters = { accepted: 2, duplicate: 1, rejected: 1, rejectedByReason: { limit_exceeded: 1 }, rejectedTerminals: 1 };
  const connectControl = async () => ({ ok: true, client: { close() {}, async request() {
    return { pid: 1, uptimeMs: 2, activeTasks: [], approvalsPending: 0,
      lifecycle: { phase: 'running', connection: 'open' },
      operationalHealth: { availability: 'available', state: 'healthy', failureCount: 0, windowMs: 1000, failureThreshold: 3, crashCount: 0 },
      storage: unmeasuredRetentionSnapshot(),
      outbound: { ...counters, lastRejection: { envelopeId: 'PRIVATE_ID_SENTINEL', type: 'task.complete', reason: 'limit_exceeded', terminal: true, payload: 'SECRET_PAYLOAD_SENTINEL' } } };
  } } }) as unknown as ConnectControlResult;
  const bundle = await createSupportBundle(config(dir), dir, { adapters: [], connectControl });
  expect(bundle.control).toMatchObject({ status: 'online', outbound: counters });
  expect(JSON.stringify(bundle)).not.toContain('PRIVATE_ID_SENTINEL');
  expect(JSON.stringify(bundle)).not.toContain('SECRET_PAYLOAD_SENTINEL');
});
