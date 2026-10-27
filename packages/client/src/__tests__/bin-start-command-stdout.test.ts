import { testAgentHomeConfig } from './fixtures/test-agent';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@byok-sdk/protocol';
import type { DaemonConfig } from '../index';
import type { Daemon } from '../daemon/create-daemon';
import type { DaemonEvent, DaemonEventListener } from '../daemon/observer';
import type { DaemonRecord } from '../daemon/daemon-record';
import {
  AUDIT_LOG_TRIM_TARGET_LINES,
  appendAuditRecord,
  auditLogPath,
  MAX_AUDIT_LOG_BYTES,
  createAuditAppender,
  readAuditRecords,
  readLastEnvironmentRecord,
} from '../bin/audit-log';
import { runStartCommand } from '../bin/commands/start';
import { runDoctorCommand } from '../bin/commands/doctor';
import { runStatusCommand } from '../bin/commands/status';
import type { ConnectControlResult } from '../bin/control-client';
import { createSupportBundle } from '../diagnostics/support-bundle';

const dirs: string[] = [];

async function tmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function offline(): Promise<ConnectControlResult> {
  return Promise.resolve({ ok: false, reason: 'daemon is not running' });
}

function config(storeDir: string): DaemonConfig {
  return {
    localAgentRelease: { version: '0.0.0-test' },
    productName: 'Acme',
    productId: 'acme-stdout',
    serverUrl: 'http://127.0.0.1:9',
    agentHome: testAgentHomeConfig(),
    storeDir,
  };
}

function fakeDaemon(): { daemon: Daemon; emit: (event: DaemonEvent) => void } {
  const listeners = new Set<DaemonEventListener>();
  const daemon: Daemon = {
    pair: vi.fn(),
    start: vi.fn().mockImplementation(async () => { for (const listener of listeners) listener({ kind: 'environment-resolved', ts: new Date().toISOString(), status: { source: 'inherited' } }); }),
    stop: vi.fn().mockResolvedValue(undefined),
    status: vi.fn().mockReturnValue({ paired: true, lifecycle: { phase: 'running', connection: 'open' }, activeTaskCount: 0 }),
    reloadMcpToolsets: vi.fn(),
    reportMcpToolsetObservation: vi.fn(),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    tasks: () => [],
    unpair: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
  };
  return { daemon, emit: (event) => { for (const listener of listeners) listener(event); } };
}

describe('bin/commands/start: stdout is the audit log (issue #395)', () => {
  it('every stdout line is a JSON record equal to its audit.jsonl line; no SENTINEL; a 30-delta, 3-tool turn is one record', async () => {
    const storeDir = await tmpDir('byok-stdout-');
    const { daemon, emit } = fakeDaemon();
    const lines: string[] = [];
    const controller = new AbortController();
    let ready = false;
    const run = runStartCommand(config(storeDir), {
      daemon, log: (l) => lines.push(l), signal: controller.signal, onReady: () => { ready = true; },
    });
    await vi.waitFor(() => expect(ready).toBe(true));
    const progress = (taskId: string, event: AgentEvent): DaemonEvent => ({ kind: 'progress', ts: 'T', taskId, event });

    let textBytes = 0;
    for (let i = 0; i < 30; i++) {
      const text = `SENTINEL-delta-${i} `;
      textBytes += Buffer.byteLength(text);
      emit(progress('t1', { type: 'progress', text }));
    }
    for (let i = 0; i < 3; i++) {
      emit(progress('t1', { type: 'tool_use', tool: 'bash', input: { command: 'cat SENTINEL-INPUT' } }));
      emit(progress('t1', { type: 'tool_result', tool: 'bash', output: 'SENTINEL-OUTPUT' }));
    }
    emit(progress('t1', { type: 'error', message: 'SENTINEL-ERROR' }));
    emit(progress('t1', { type: 'usage', inputTokens: 10, outputTokens: 5, totalTokens: 15 }));
    emit(progress('t1', { type: 'turn_end' }));
    emit({ kind: 'awaiting-approval', ts: 'T', taskId: 't1', approvalId: 'ap-1', summary: 'SENTINEL-APPROVAL' });
    emit({ kind: 'completed', ts: 'T', taskId: 't1', summary: 'SENTINEL-FINAL-ANSWER', sessionRef: 'sess-1' });
    emit(progress('t2', { type: 'progress', text: 'SENTINEL-PARTIAL' }));
    emit({ kind: 'failed', ts: 'T', taskId: 't2', reason: 'SENTINEL-FAIL-REASON', retryable: false });
    emit({ kind: 'cancelled', ts: 'T', taskId: 't3', reason: 'SENTINEL-CANCEL-REASON' });
    emit({ kind: 'shutdown-requested', ts: 'T', reason: 'SENTINEL-SHUTDOWN' });
    emit(progress('t4', { type: 'progress', text: 'SENTINEL-OPEN-AT-STOP' }));

    controller.abort();
    await run;

    const audit = await fs.readFile(auditLogPath(storeDir), 'utf8');
    expect(lines).toEqual(audit.trimEnd().split('\n'));
    expect(audit).not.toContain('SENTINEL');
    const records = lines.map((line) => JSON.parse(line) as DaemonRecord);
    expect(records.map((record) => record.kind)).toEqual([
      'environment-resolved', 'daemon-started', 'turn', 'awaiting-approval', 'completed', 'turn', 'failed', 'cancelled',
      'shutdown-requested', 'turn', 'daemon-stopped',
    ]);
    expect(records.filter((record) => record.kind === 'turn')).toEqual([
      {
        kind: 'turn', ts: 'T', taskId: 't1', turn: 1, closedBy: 'turn_end', progressEvents: 39, textBytes,
        toolUses: 3, toolResults: 3, artifacts: 0, errors: 1, inputTokens: 10, outputTokens: 5, totalTokens: 15,
      },
      expect.objectContaining({ taskId: 't2', closedBy: 'terminal', textBytes: Buffer.byteLength('SENTINEL-PARTIAL') }),
      expect.objectContaining({ taskId: 't4', closedBy: 'stop' }),
    ]);
    expect(records).toContainEqual({ kind: 'failed', ts: 'T', taskId: 't2', retryable: false, reasonBytes: Buffer.byteLength('SENTINEL-FAIL-REASON') });
    expect(records[1]).toMatchObject({ kind: 'daemon-started', productId: 'acme-stdout' });
  });
});

describe('bin/audit-log: environment-resolved record (issue #392)', () => {
  it('start persists the daemon environment event; status/doctor/bundle read it back without paths', async () => {
    const storeDir = await tmpDir('byok-envrec-');
    const { daemon, emit } = fakeDaemon();
    const lines: string[] = [];
    const controller = new AbortController();
    const run = runStartCommand(config(storeDir), { daemon, log: (l) => lines.push(l), signal: controller.signal, onReady: () => { controller.abort(); } });
    await run;
    expect(lines.map(line => JSON.parse(line)).filter(record => record.kind === 'environment-resolved')).toEqual([expect.objectContaining({ source: 'inherited' })]);
    expect(await readLastEnvironmentRecord(storeDir)).toMatchObject({ status: { source: 'inherited' } });
    const status: string[] = [];
    await runStatusCommand(config(storeDir), { connectControl: offline, log: (l) => status.push(l) });
    expect(status.some((l) => /^environment: inherited at=\d{4}-/u.test(l))).toBe(true);

    await appendAuditRecord(storeDir, { kind: 'environment-resolved', ts: '2026-10-13T00:00:00.000Z', source: 'login-shell', shell: 'zsh', durationMs: 530 });
    const doctor: string[] = [];
    await runDoctorCommand(config(storeDir), { connectControl: offline, log: (l) => doctor.push(l) });
    expect(doctor).toContain('environment: login-shell shell=zsh durationMs=530 at=2026-10-13T00:00:00.000Z');
    const bundle = await createSupportBundle(config(storeDir), storeDir, { adapters: [], connectControl: offline });
    expect(bundle.environment).toEqual({ ts: '2026-10-13T00:00:00.000Z', status: { source: 'login-shell', shell: 'zsh', durationMs: 530 } });
    expect(JSON.stringify(bundle)).not.toContain(storeDir);
  });

  it('rejects open-ended values, and survives audit rotation', async () => {
    const storeDir = await tmpDir('byok-envrec-rot-');
    await appendAuditRecord(storeDir, { kind: 'environment-resolved', ts: '2026-10-13T00:00:00.000Z', source: 'unavailable', code: 'timeout' });
    expect(await readAuditRecords(storeDir)).toEqual([{ kind: 'environment-resolved', ts: '2026-10-13T00:00:00.000Z', source: 'unavailable', code: 'timeout' }]);
    await expect(appendAuditRecord(storeDir, { kind: 'environment-resolved', ts: '2026-10-13T00:00:01.000Z', source: 'inherited', PATH: '/private/sentinel' } as unknown as import('../daemon/daemon-record').DaemonRecord)).rejects.toThrow('invalid environment-resolved record');
    expect(await fs.readFile(auditLogPath(storeDir), 'utf8')).not.toContain('/private/sentinel');
    // A forged record with a path or an unknown code is ignored, not echoed.
    await fs.appendFile(auditLogPath(storeDir), `${JSON.stringify({ kind: 'environment-resolved', ts: '2026-10-13T00:00:01.000Z', source: 'unavailable', code: '/Users/me/.zshrc' })}\n`);
    await fs.appendFile(auditLogPath(storeDir), `${JSON.stringify({ kind: 'environment-resolved', ts: '2026-10-13T00:00:02.000Z', source: 'login-shell', shell: 'zsh', durationMs: 1, PATH: '/x' })}\n`);
    expect(await readLastEnvironmentRecord(storeDir)).toEqual({ ts: '2026-10-13T00:00:00.000Z', status: { source: 'unavailable', code: 'timeout' } });

    const runtimes: DaemonEvent = { kind: 'runtimes-detected', ts: '2026-10-13T00:00:03.000Z', runtimes: [{ id: 'claude', outcome: 'not-found', present: false, steer: true, resume: true }] };
    await appendAuditRecord(storeDir, runtimes);
    // Push the log past the cap; both startup observations must remain available offline.
    const padding = 'x'.repeat(Math.ceil(MAX_AUDIT_LOG_BYTES / (AUDIT_LOG_TRIM_TARGET_LINES * 2)));
    const filler = Array.from({ length: AUDIT_LOG_TRIM_TARGET_LINES * 3 }, (_, i) =>
      JSON.stringify({ kind: 'lifecycle', ts: `2026-10-13T00:01:00.${String(i % 1000).padStart(3, '0')}Z`, lifecycle: { phase: 'running', connection: 'open' }, pad: padding }),
    );
    await fs.appendFile(auditLogPath(storeDir), `${filler.join('\n')}\n`);
    await appendAuditRecord(storeDir, { kind: 'lifecycle', ts: '2026-10-13T00:02:00.000Z', lifecycle: { phase: 'running', connection: 'open' } });
    const size = (await fs.stat(auditLogPath(storeDir))).size;
    expect(size).toBeLessThan(MAX_AUDIT_LOG_BYTES);
    expect((await readAuditRecords(storeDir)).find(event => event.kind === 'runtimes-detected')).toEqual(runtimes);
    expect(await readLastEnvironmentRecord(storeDir)).toEqual({ ts: '2026-10-13T00:00:00.000Z', status: { source: 'unavailable', code: 'timeout' } });
  });

  it('goes through the same appender chain as every record: queued behind pending appends and a rotation, never lost', async () => {
    const storeDir = await tmpDir('byok-envrec-chain-');
    // Over the cap, so the next event append rotates the log.
    const padding = 'x'.repeat(Math.ceil(MAX_AUDIT_LOG_BYTES / (AUDIT_LOG_TRIM_TARGET_LINES * 2)));
    const filler = Array.from({ length: AUDIT_LOG_TRIM_TARGET_LINES * 3 }, (_, i) =>
      JSON.stringify({ kind: 'lifecycle', ts: `2026-10-13T00:01:00.${String(i % 1000).padStart(3, '0')}Z`, lifecycle: { phase: 'running', connection: 'open' }, pad: padding }),
    );
    await fs.writeFile(auditLogPath(storeDir), `${filler.join('\n')}\n`);
    const errors: unknown[] = [];
    const appender = createAuditAppender(storeDir, (err) => errors.push(err));
    for (let i = 0; i < 20; i++) appender.append({ kind: 'lifecycle', ts: `2026-10-13T00:02:00.${String(i).padStart(3, '0')}Z`, lifecycle: { phase: 'running', connection: 'open' } });
    appender.append({ kind: 'environment-resolved', ts: '2026-10-13T00:03:00.000Z', source: 'inherited' });
    await appender.flush();

    expect(errors).toEqual([]);
    const lines = (await fs.readFile(auditLogPath(storeDir), 'utf8')).trimEnd().split('\n');
    expect(JSON.parse(lines.at(-1)!)).toEqual({ kind: 'environment-resolved', ts: '2026-10-13T00:03:00.000Z', source: 'inherited' });
    expect(lines.slice(-21, -1).map((line) => (JSON.parse(line) as { ts: string }).ts)).toEqual(
      Array.from({ length: 20 }, (_, i) => `2026-10-13T00:02:00.${String(i).padStart(3, '0')}Z`),
    );
    expect(await readLastEnvironmentRecord(storeDir)).toEqual({ ts: '2026-10-13T00:03:00.000Z', status: { source: 'inherited' } });
  });
});
