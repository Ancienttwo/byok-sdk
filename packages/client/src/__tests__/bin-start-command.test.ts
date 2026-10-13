import { testScratchRoot } from "./fixtures/execution-scratch";
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import type { DaemonEventListener } from '../daemon/observer';
import { readAuditEvents } from '../bin/audit-log';
import { DaemonCrashedError, runStartCommand, startExitCode } from '../bin/commands/start';
import { DaemonHaltError } from '../daemon/daemon-lifecycle';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * `runStartCommand` is the piece of M3-2b with the most new integration
 * surface (subscribe -> audit log + stdout, banner line, wait-for-abort,
 * clean unsubscribe/stop) — worth exercising against a REAL daemon (real
 * pair()/start(), a real TestServer, a stub-adapter task) rather than only a
 * hand-built stub, the way daemon-observer.test.ts already does for the
 * underlying `DaemonObserver` itself.
 */
describe('bin/commands/start: runStartCommand (real daemon + TestServer)', () => {
  let server: TestServer;
  let daemon: Daemon | undefined;

  beforeEach(async () => {
    server = await TestServer.start();
  });

  afterEach(async () => {
    await daemon?.stop();
    daemon = undefined;
    await server.close();
  });

  it('appends every observed DaemonEvent to the audit log and mirrors it to stdout, then stops cleanly on abort', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const workspaceRoot = await tmpDir('byok-start-workspace-');
    const storeDir = await tmpDir('byok-start-store-');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() },
        localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme',
        productId: 'acme-start-product',
        serverUrl: server.url,
        workspaceRoot,
        storeDir,
        branding: { displayName: 'Acme Coder' },
      },
      [adapter],
    );
    await daemon.pair('pairing-code');

    const lines: string[] = [];
    const controller = new AbortController();
    let ready = false;

    const startPromise = runStartCommand(
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme', productId: 'acme-start-product', serverUrl: server.url, workspaceRoot, storeDir, branding: { displayName: 'Acme Coder' } },
      {
        daemon,
        log: (l) => lines.push(l),
        error: (l) => lines.push(`ERR: ${l}`),
        signal: controller.signal,
        onReady: () => {
          ready = true;
        },
      },
    );

    await vi.waitFor(() => expect(ready).toBe(true));
    expect(lines.some((l) => l.startsWith('daemon started: product=Acme Coder (acme-start-product)'))).toBe(true);

    // Drive one task through so the audit log picks up task-lifecycle events too.
    server.send(
      createEnvelope(
        'task.offer',
        { instruction: 'do the thing' },
        { taskId: 'task-1', seq: server.nextSeq() },
      ),
    );
    await server.waitFor((e) => e.type === 'task.started');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    adapter.sessions[0]?.emit({ type: 'turn_end' });
    await server.waitFor((e) => e.type === 'task.complete');

    await vi.waitFor(async () => {
      const events = await readAuditEvents(storeDir);
      expect(events.some((e) => e.kind === 'completed' && e.taskId === 'task-1')).toBe(true);
    });

    const auditEvents = await readAuditEvents(storeDir);
    expect(auditEvents.some((e) => e.kind === 'lifecycle')).toBe(true);
    expect(auditEvents.some((e) => e.kind === 'runtimes-detected')).toBe(true);
    expect(auditEvents.some((e) => e.kind === 'claimed' && e.taskId === 'task-1')).toBe(true);

    // stdout mirrors the SAME events via the SAME formatter `tasks --follow` uses.
    expect(lines.some((l) => l.includes('completed taskId=task-1'))).toBe(true);

    controller.abort();
    await startPromise;
    expect(lines).toContain('daemon stopped');
  });

  it('an audit-log write failure is reported via error() but does not stop the daemon from starting', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const workspaceRoot = await tmpDir('byok-start-workspace-badlog-');
    const parent = await tmpDir('byok-start-store-badlog-parent-');
    // storeDir itself is a FILE, not a directory — every audit append's own
    // `fs.mkdir(storeDir, {recursive:true})` will reject.
    const storeDir = path.join(parent, 'not-a-directory');
    await fs.writeFile(storeDir, 'x');

    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() },  localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme', productId: 'acme-start-badlog', serverUrl: server.url, workspaceRoot, storeDir: parent },
      [adapter],
    );
    // Daemon itself uses `parent` (a real dir) for its OWN device store, but
    // we pass the broken `storeDir` to runStartCommand's audit-log resolution
    // by overriding config.storeDir — see below.
    await daemon.pair('pairing-code');

    const lines: string[] = [];
    const controller = new AbortController();
    let ready = false;

    const startPromise = runStartCommand(
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme', productId: 'acme-start-badlog', serverUrl: server.url, workspaceRoot, storeDir },
      {
        daemon,
        log: (l) => lines.push(l),
        error: (l) => lines.push(`ERR: ${l}`),
        signal: controller.signal,
        onReady: () => {
          ready = true;
        },
      },
    );

    await vi.waitFor(() => expect(ready).toBe(true));
    await vi.waitFor(() => expect(lines.some((l) => l.startsWith('ERR: audit log append failed'))).toBe(true));

    controller.abort();
    await startPromise;
  });

  it('finding F8: an awaiting-approval event\'s stdout line is redacted (no raw tool-input text) even though the SAME event is otherwise rendered in full', async () => {
    const listeners = new Set<DaemonEventListener>();
    const rawSummary = 'Bash: rm -rf /etc/passwd && cat /home/user/.ssh/id_rsa';
    const fakeDaemon: Daemon = {
      pair: vi.fn(),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      status: vi.fn().mockReturnValue({ paired: true, lifecycle: { phase: 'running', connection: 'open' }, activeTaskCount: 1 }),
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
    const storeDir = await tmpDir('byok-start-store-redact-');

    const lines: string[] = [];
    const controller = new AbortController();
    const startPromise = runStartCommand(
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme', productId: 'acme-start-redact', serverUrl: 'http://example.invalid', workspaceRoot: '/ws', storeDir },
      { daemon: fakeDaemon, log: (l) => lines.push(l), signal: controller.signal },
    );

    await vi.waitFor(() => expect(listeners.size).toBe(1));
    for (const listener of listeners) {
      listener({ kind: 'awaiting-approval', ts: '2026-01-01T00:00:00.000Z', taskId: 'task-1', summary: rawSummary, approvalId: 'appr-1' });
    }

    await vi.waitFor(() => expect(lines.some((l) => l.includes('awaiting-approval'))).toBe(true));
    const approvalLine = lines.find((l) => l.includes('awaiting-approval'))!;

    // The raw tool-input text must never reach stdout ...
    expect(approvalLine).not.toContain(rawSummary);
    expect(approvalLine).not.toContain('id_rsa');
    expect(approvalLine).not.toContain('/etc/passwd');
    // ... but the line is still otherwise fully rendered (taskId, approvalId,
    // a byte-count placeholder in place of the summary — not just dropped).
    expect(approvalLine).toContain('taskId=task-1');
    expect(approvalLine).toContain('approvalId=appr-1');
    expect(approvalLine).toContain(`[redacted: ${Buffer.byteLength(rawSummary, 'utf8')} bytes]`);

    controller.abort();
    await startPromise;
  });

  it('propagates an error from daemon.start() after unsubscribing and best-effort stopping', async () => {
    const listeners = new Set<DaemonEventListener>();
    const stop = vi.fn().mockResolvedValue(undefined);
    const fakeDaemon: Daemon = {
      pair: vi.fn(),
      start: vi.fn().mockRejectedValue(new Error('boom-start')),
      stop,
      status: vi.fn().mockReturnValue({ paired: true, lifecycle: { phase: 'running', connection: 'connecting' }, activeTaskCount: 0 }),
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
    const storeDir = await tmpDir('byok-start-store-throw-');

    await expect(
      runStartCommand(
        { localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme', productId: 'acme-start-throw', serverUrl: 'http://example.invalid', workspaceRoot: '/ws', storeDir },
        { daemon: fakeDaemon, signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/boom-start/);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0); // unsubscribed
  });

  it('#394: a revoked device ends start as halted/device_revoked after one authentication, recorded in the audit log', async () => {
    const workspaceRoot = await tmpDir('byok-start-workspace-');
    const storeDir = await tmpDir('byok-start-store-revoked-');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() },  localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme', productId: 'acme-start-revoked', serverUrl: server.url, workspaceRoot, storeDir },
      [new StubRuntimeAdapter('pi')],
    );
    const record = await daemon.pair('pairing-code');
    server.revokeDevice(record.deviceId);
    const challengesBefore = server.httpRequests.filter((request) => request.pathname === '/byok/challenge').length;
    const errors: string[] = [];

    const outcome = await runStartCommand(
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme', productId: 'acme-start-revoked', serverUrl: server.url, workspaceRoot, storeDir },
      { daemon, log: () => {}, error: (line) => errors.push(line), signal: new AbortController().signal },
    );

    expect(outcome).toEqual({ kind: 'halted', reason: 'device_revoked' });
    expect(startExitCode(outcome, false)).toBe(78);
    expect(startExitCode(outcome, true)).toBe(0);
    expect(server.httpRequests.filter((request) => request.pathname === '/byok/challenge').length - challengesBefore).toBe(1);
    expect(errors.some((line) => line.startsWith('daemon halted: reason=device_revoked'))).toBe(true);
    const audit = await readAuditEvents(storeDir);
    expect(audit.filter((event) => event.kind === 'lifecycle').at(-1)).toMatchObject({
      lifecycle: { phase: 'halted', reason: 'device_revoked' },
    });
  });

  it('#394: a DaemonHaltError from start() is a halted outcome, not a throw, after stopping and unsubscribing', async () => {
    const listeners = new Set<DaemonEventListener>();
    const stop = vi.fn().mockResolvedValue(undefined);
    const fakeDaemon: Daemon = {
      pair: vi.fn(),
      start: vi.fn().mockRejectedValue(new DaemonHaltError('unpaired')),
      stop,
      status: vi.fn().mockReturnValue({ paired: false, lifecycle: { phase: 'stopped' }, activeTaskCount: 0 }),
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
    const storeDir = await tmpDir('byok-start-store-unpaired-');
    const errors: string[] = [];

    const outcome = await runStartCommand(
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme', productId: 'acme-start-unpaired', serverUrl: 'http://example.invalid', workspaceRoot: '/ws', storeDir },
      { daemon: fakeDaemon, error: (line) => errors.push(line), log: () => {}, signal: new AbortController().signal },
    );

    expect(outcome).toEqual({ kind: 'halted', reason: 'unpaired' });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
    expect(errors.some((line) => line.startsWith('daemon halted: reason=unpaired'))).toBe(true);
  });
});

describe('bin/commands/start: a crash after start (#394)', () => {
  it('stops the daemon, unsubscribes, and throws DaemonCrashedError (exit 1) when lifecycle reports crashed', async () => {
    const listeners = new Set<DaemonEventListener>();
    const stop = vi.fn().mockResolvedValue(undefined);
    const fakeDaemon: Daemon = {
      pair: vi.fn(),
      start: vi.fn().mockImplementation(async () => {
        setTimeout(() => {
          for (const listener of listeners) listener({ kind: 'lifecycle', ts: 'T', lifecycle: { phase: 'crashed', at: 'T' } });
        }, 10);
      }),
      stop,
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
    const storeDir = await tmpDir('byok-start-store-crashed-');

    await expect(runStartCommand(
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme', productId: 'acme-start-crashed', serverUrl: 'http://example.invalid', workspaceRoot: '/ws', storeDir },
      { daemon: fakeDaemon, log: () => {}, error: () => {}, signal: new AbortController().signal },
    )).rejects.toBeInstanceOf(DaemonCrashedError);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
    const audit = await readAuditEvents(storeDir);
    expect(audit.filter((event) => event.kind === 'lifecycle').at(-1)).toMatchObject({ lifecycle: { phase: 'crashed' } });
  });
});

describe('bin/commands/start: startExitCode (#394)', () => {
  it('maps stopped to 0 and a halt to 78 in the foreground, and both to 0 under --service', () => {
    expect(startExitCode({ kind: 'stopped' }, false)).toBe(0);
    expect(startExitCode({ kind: 'stopped' }, true)).toBe(0);
    for (const reason of ['unpaired', 're_pair_required', 'store_owned', 'device_revoked', 'handshake_rejected', 'replay_cursor_too_old', 'config_invalid'] as const) {
      expect(startExitCode({ kind: 'halted', reason }, false)).toBe(78);
      expect(startExitCode({ kind: 'halted', reason }, true)).toBe(0);
    }
  });
});
