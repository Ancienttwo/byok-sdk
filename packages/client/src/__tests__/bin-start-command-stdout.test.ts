import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@byok-sdk/protocol';
import type { DaemonConfig } from '../index';
import type { Daemon } from '../daemon/create-daemon';
import type { DaemonEvent, DaemonEventListener } from '../daemon/observer';
import {
  AUDIT_LOG_TRIM_TARGET_LINES,
  auditLogPath,
  MAX_AUDIT_LOG_BYTES,
  appendAuditEvent,
  createAuditAppender,
  readAuditEvents,
  readLastAuditEvent,
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
    workspaceRoot: storeDir,
    storeDir,
  };
}

function fakeDaemon(): { daemon: Daemon; emit: (event: DaemonEvent) => void } {
  const listeners = new Set<DaemonEventListener>();
  const daemon: Daemon = {
    pair: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
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

describe('bin/commands/start: stdout carries no model text (issue #395, minimal)', () => {
  it('SENTINEL text never reaches stdout or audit.jsonl; a 30-delta, 3-tool turn is one line', async () => {
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
    emit(progress('t1', { type: 'needs_approval', summary: 'SENTINEL-APPROVAL' }));
    emit(progress('t1', { type: 'error', message: 'SENTINEL-ERROR' }));
    emit(progress('t1', { type: 'usage', inputTokens: 10, outputTokens: 5, totalTokens: 15 }));
    emit(progress('t1', { type: 'turn_end' }));
    emit({ kind: 'awaiting-approval', ts: 'T', taskId: 't1', approvalId: 'ap-1', summary: 'SENTINEL-APPROVAL' });
    emit({ kind: 'completed', ts: 'T', taskId: 't1', summary: 'SENTINEL-FINAL-ANSWER', sessionRef: 'sess-1' });
    emit(progress('t2', { type: 'progress', text: 'SENTINEL-PARTIAL' }));
    emit({ kind: 'failed', ts: 'T', taskId: 't2', reason: 'SENTINEL-FAIL-REASON', retryable: false });
    emit({ kind: 'cancelled', ts: 'T', taskId: 't3', reason: 'SENTINEL-CANCEL-REASON' });
    emit(progress('t4', { type: 'progress', text: 'SENTINEL-OPEN-AT-STOP' }));

    controller.abort();
    await run;

    expect(lines.join('\n')).not.toContain('SENTINEL');
    await vi.waitFor(async () => {
      const audit = await fs.readFile(auditLogPath(storeDir), 'utf8');
      expect(audit).toContain('"kind":"cancelled"');
      expect(audit).not.toContain('SENTINEL');
    });
    expect(lines.filter((l) => l.includes('progress taskId=t1'))).toEqual([
      `[T] progress taskId=t1 turn=end events=40 text=30 textBytes=${textBytes} tool_use=3 tool_result=3 artifact=0 needs_approval=1 error=1 usage=in:10,out:5,total:15`,
    ]);
    const t2 = lines.findIndex((l) => l.includes('progress taskId=t2 turn=open'));
    expect(lines[t2 + 1]).toBe(`[T] failed taskId=t2 retryable=false reason="[redacted: ${Buffer.byteLength('SENTINEL-FAIL-REASON')} bytes]"`);
    expect(lines.filter((l) => l.includes('progress taskId=t4 turn=open'))).toHaveLength(1);
    expect(lines.filter((l) => l.includes(' progress taskId='))).toHaveLength(3);
  });
});

describe('environment-resolved is a DaemonEvent in the audit log (issue #392)', () => {
  it('reaches audit.jsonl through start\'s subscribe->append; status/doctor/bundle read it back without paths', async () => {
    const storeDir = await tmpDir('byok-envrec-');
    const { daemon, emit } = fakeDaemon();
    vi.mocked(daemon.start).mockImplementation(async () => {
      emit({ kind: 'environment-resolved', ts: '2026-10-13T00:00:00.000Z', source: 'inherited' });
    });
    const lines: string[] = [];
    const controller = new AbortController();
    await runStartCommand(config(storeDir), { daemon, log: (l) => lines.push(l), signal: controller.signal, onReady: () => controller.abort() });
    expect(lines[0]).toBe('environment: inherited');
    expect(lines).toContain('[2026-10-13T00:00:00.000Z] environment-resolved inherited');
    expect(await readAuditEvents(storeDir)).toEqual([{ kind: 'environment-resolved', ts: '2026-10-13T00:00:00.000Z', source: 'inherited' }]);
    const status: string[] = [];
    await runStatusCommand(config(storeDir), { connectControl: offline, log: (l) => status.push(l) });
    expect(status).toContain('environment: last-known inherited at=2026-10-13T00:00:00.000Z');

    await appendAuditEvent(storeDir, { kind: 'environment-resolved', ts: '2026-10-13T00:00:01.000Z', source: 'login-shell', shell: 'zsh', durationMs: 530 });
    const doctor: string[] = [];
    await runDoctorCommand(config(storeDir), { adapters: [], connectControl: offline, log: (l) => doctor.push(l) });
    expect(doctor).toContain('check environment: pass (audit login-shell shell=zsh durationMs=530 at=2026-10-13T00:00:01.000Z)');
    const bundle = await createSupportBundle(config(storeDir), storeDir, { adapters: [], connectControl: offline });
    expect(bundle.environment).toEqual({
      status: 'known',
      source: 'audit',
      ts: '2026-10-13T00:00:01.000Z',
      environment: { source: 'login-shell', shell: 'zsh', durationMs: 530 },
    });
    expect(JSON.stringify(bundle)).not.toContain(storeDir);
  });

  it('parses #409-era lines, drops forged values instead of echoing them, and survives audit rotation', async () => {
    const storeDir = await tmpDir('byok-envrec-rot-');
    // The line #409's bin-side writer produced has exactly the event's flat shape.
    await fs.appendFile(auditLogPath(storeDir), `${JSON.stringify({ kind: 'environment-resolved', ts: '2026-10-13T00:00:00.000Z', source: 'unavailable', code: 'timeout' })}\n`);
    expect(await readAuditEvents(storeDir)).toEqual([{ kind: 'environment-resolved', ts: '2026-10-13T00:00:00.000Z', source: 'unavailable', code: 'timeout' }]);
    // A forged line with a path for a code, or a path-shaped shell, is dropped.
    await fs.appendFile(auditLogPath(storeDir), `${JSON.stringify({ kind: 'environment-resolved', ts: '2026-10-13T00:00:01.000Z', source: 'unavailable', code: '/Users/me/.zshrc' })}\n`);
    await fs.appendFile(auditLogPath(storeDir), `${JSON.stringify({ kind: 'environment-resolved', ts: '2026-10-13T00:00:02.000Z', source: 'login-shell', shell: '/bin/zsh', durationMs: 1 })}\n`);
    expect(await readLastAuditEvent(storeDir, 'environment-resolved')).toEqual({ kind: 'environment-resolved', ts: '2026-10-13T00:00:00.000Z', source: 'unavailable', code: 'timeout' });
    // An extra field is never carried into the event.
    await fs.appendFile(auditLogPath(storeDir), `${JSON.stringify({ kind: 'environment-resolved', ts: '2026-10-13T00:00:03.000Z', source: 'inherited', PATH: '/secret/bin' })}\n`);
    const extra = await readLastAuditEvent(storeDir, 'environment-resolved');
    expect(extra).toEqual({ kind: 'environment-resolved', ts: '2026-10-13T00:00:03.000Z', source: 'inherited' });
    expect(JSON.stringify(extra)).not.toContain('/secret/bin');

    // Push the log past the rotation cap with ordinary events; the environment event is kept.
    const padding = 'x'.repeat(Math.ceil(MAX_AUDIT_LOG_BYTES / (AUDIT_LOG_TRIM_TARGET_LINES * 2)));
    const filler = Array.from({ length: AUDIT_LOG_TRIM_TARGET_LINES * 3 }, (_, i) =>
      JSON.stringify({ kind: 'lifecycle', ts: `2026-10-13T00:01:00.${String(i % 1000).padStart(3, '0')}Z`, lifecycle: { phase: 'running', connection: 'open' }, pad: padding }),
    );
    await fs.appendFile(auditLogPath(storeDir), `${filler.join('\n')}\n`);
    await appendAuditEvent(storeDir, { kind: 'lifecycle', ts: '2026-10-13T00:02:00.000Z', lifecycle: { phase: 'running', connection: 'open' } });
    const size = (await fs.stat(auditLogPath(storeDir))).size;
    expect(size).toBeLessThan(MAX_AUDIT_LOG_BYTES);
    expect(await readLastAuditEvent(storeDir, 'environment-resolved')).toEqual({ kind: 'environment-resolved', ts: '2026-10-13T00:00:03.000Z', source: 'inherited' });
  });

  it('goes through the appender\'s chain like every event: queued behind pending appends and a rotation, never lost', async () => {
    const storeDir = await tmpDir('byok-envrec-chain-');
    // Over the cap, so the next event append rotates the log.
    const padding = 'x'.repeat(Math.ceil(MAX_AUDIT_LOG_BYTES / (AUDIT_LOG_TRIM_TARGET_LINES * 2)));
    const filler = Array.from({ length: AUDIT_LOG_TRIM_TARGET_LINES * 3 }, (_, i) =>
      JSON.stringify({ kind: 'lifecycle', ts: `2026-10-13T00:01:00.${String(i % 1000).padStart(3, '0')}Z`, lifecycle: { phase: 'running', connection: 'open' }, pad: padding }),
    );
    await fs.writeFile(auditLogPath(storeDir), `${filler.join('\n')}\n`);
    const errors: unknown[] = [];
    const appender = createAuditAppender(storeDir, (err) => errors.push(err));
    for (let i = 0; i < 20; i++) appender({ kind: 'lifecycle', ts: `2026-10-13T00:02:00.${String(i).padStart(3, '0')}Z`, lifecycle: { phase: 'running', connection: 'open' } });
    appender({ kind: 'environment-resolved', ts: '2026-10-13T00:03:00.000Z', source: 'inherited' });
    await appender.flush();

    expect(errors).toEqual([]);
    const lines = (await fs.readFile(auditLogPath(storeDir), 'utf8')).trimEnd().split('\n');
    expect(JSON.parse(lines.at(-1)!)).toEqual({ kind: 'environment-resolved', ts: '2026-10-13T00:03:00.000Z', source: 'inherited' });
    expect(lines.slice(-21, -1).map((line) => (JSON.parse(line) as { ts: string }).ts)).toEqual(
      Array.from({ length: 20 }, (_, i) => `2026-10-13T00:02:00.${String(i).padStart(3, '0')}Z`),
    );
    expect(await readLastAuditEvent(storeDir, 'environment-resolved')).toEqual({ kind: 'environment-resolved', ts: '2026-10-13T00:03:00.000Z', source: 'inherited' });
  });
});
