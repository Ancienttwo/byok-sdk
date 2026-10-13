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
  appendEnvironmentRecord,
  auditLogPath,
  MAX_AUDIT_LOG_BYTES,
  appendAuditEvent,
  readAuditEvents,
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
    status: vi.fn().mockReturnValue({ paired: true, connected: true, revoked: false, activeTaskCount: 0 }),
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

describe('bin/audit-log: environment-resolved record (issue #392)', () => {
  it('start records inherited by default; status/doctor/bundle read it back without paths', async () => {
    const storeDir = await tmpDir('byok-envrec-');
    const { daemon } = fakeDaemon();
    const lines: string[] = [];
    const controller = new AbortController();
    const run = runStartCommand(config(storeDir), { daemon, log: (l) => lines.push(l), signal: controller.signal, onReady: () => controller.abort() });
    await run;
    expect(lines[0]).toBe('environment: inherited');
    expect(await readLastEnvironmentRecord(storeDir)).toMatchObject({ status: { source: 'inherited' } });
    const status: string[] = [];
    await runStatusCommand(config(storeDir), { adapters: [], connectControl: offline, log: (l) => status.push(l) });
    expect(status.some((l) => /^environment: inherited at=\d{4}-/u.test(l))).toBe(true);

    await appendEnvironmentRecord(storeDir, { ts: '2026-10-13T00:00:00.000Z', status: { source: 'login-shell', shell: 'zsh', durationMs: 530 } });
    const doctor: string[] = [];
    await runDoctorCommand(config(storeDir), { adapters: [], connectControl: offline, log: (l) => doctor.push(l) });
    expect(doctor).toContain('environment: login-shell shell=zsh durationMs=530 at=2026-10-13T00:00:00.000Z');
    const bundle = await createSupportBundle(config(storeDir), storeDir, { adapters: [], connectControl: offline });
    expect(bundle.environment).toEqual({ ts: '2026-10-13T00:00:00.000Z', status: { source: 'login-shell', shell: 'zsh', durationMs: 530 } });
    expect(JSON.stringify(bundle)).not.toContain(storeDir);
  });

  it('is not a DaemonEvent, rejects open-ended values, and survives audit rotation', async () => {
    const storeDir = await tmpDir('byok-envrec-rot-');
    await appendEnvironmentRecord(storeDir, { ts: '2026-10-13T00:00:00.000Z', status: { source: 'unavailable', code: 'timeout' } });
    expect(await readAuditEvents(storeDir)).toEqual([]);
    // A forged record with a path or an unknown code is ignored, not echoed.
    await fs.appendFile(auditLogPath(storeDir), `${JSON.stringify({ kind: 'environment-resolved', ts: '2026-10-13T00:00:01.000Z', source: 'unavailable', code: '/Users/me/.zshrc' })}\n`);
    await fs.appendFile(auditLogPath(storeDir), `${JSON.stringify({ kind: 'environment-resolved', ts: '2026-10-13T00:00:02.000Z', source: 'login-shell', shell: 'zsh', durationMs: 1, PATH: '/x' })}\n`);
    expect(await readLastEnvironmentRecord(storeDir)).toEqual({ ts: '2026-10-13T00:00:00.000Z', status: { source: 'unavailable', code: 'timeout' } });

    // Push the log past the rotation cap with ordinary events; the environment record is kept.
    const padding = 'x'.repeat(Math.ceil(MAX_AUDIT_LOG_BYTES / (AUDIT_LOG_TRIM_TARGET_LINES * 2)));
    const filler = Array.from({ length: AUDIT_LOG_TRIM_TARGET_LINES * 3 }, (_, i) =>
      JSON.stringify({ kind: 'connection', ts: `2026-10-13T00:01:00.${String(i % 1000).padStart(3, '0')}Z`, state: 'open', pad: padding }),
    );
    await fs.appendFile(auditLogPath(storeDir), `${filler.join('\n')}\n`);
    await appendAuditEvent(storeDir, { kind: 'connection', ts: '2026-10-13T00:02:00.000Z', state: 'open' });
    const size = (await fs.stat(auditLogPath(storeDir))).size;
    expect(size).toBeLessThan(MAX_AUDIT_LOG_BYTES);
    expect(await readLastEnvironmentRecord(storeDir)).toEqual({ ts: '2026-10-13T00:00:00.000Z', status: { source: 'unavailable', code: 'timeout' } });
  });
});
