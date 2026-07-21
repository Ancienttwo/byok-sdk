import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok/protocol';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import type { DaemonEventListener } from '../daemon/observer';
import { readAuditEvents } from '../bin/audit-log';
import { runStartCommand } from '../bin/commands/start';
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
      {
        productName: 'Acme',
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
      { productName: 'Acme', productId: 'acme-start-product', serverUrl: server.url, workspaceRoot, storeDir, branding: { displayName: 'Acme Coder' } },
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
        { instruction: 'do the thing', policy: { mode: 'auto' } },
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
    expect(auditEvents.some((e) => e.kind === 'connection')).toBe(true);
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
      { productName: 'Acme', productId: 'acme-start-badlog', serverUrl: server.url, workspaceRoot, storeDir: parent },
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
      { productName: 'Acme', productId: 'acme-start-badlog', serverUrl: server.url, workspaceRoot, storeDir },
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
      status: vi.fn().mockReturnValue({ paired: true, connected: true, degraded: false, revoked: false, activeTaskCount: 1 }),
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
      { productName: 'Acme', productId: 'acme-start-redact', serverUrl: 'http://example.invalid', workspaceRoot: '/ws', storeDir },
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
      status: vi.fn().mockReturnValue({ paired: true, connected: false, degraded: false, revoked: false, activeTaskCount: 0 }),
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
        { productName: 'Acme', productId: 'acme-start-throw', serverUrl: 'http://example.invalid', workspaceRoot: '/ws', storeDir },
        { daemon: fakeDaemon, signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/boom-start/);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0); // unsubscribed
  });
});
