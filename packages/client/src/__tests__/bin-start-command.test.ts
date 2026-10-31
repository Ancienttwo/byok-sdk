import { freshTestAgentRef, testAgentHomeConfig } from './fixtures/test-agent';
import { testScratchRoot } from "./fixtures/execution-scratch";
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import type { DaemonEventListener } from '../daemon/observer';
import type { DaemonRecord } from '../daemon/daemon-record';
import { auditLogPath, readAuditRecords } from '../daemon/audit-log';
import { DaemonCrashedError, formatStartErrorReason, runStartCommand } from '../bin/commands/start';
import { daemonExitCode } from '../lifecycle/exit-codes';
import { DaemonHaltError } from '../daemon/daemon-lifecycle';
import { createSupportBundle } from '../diagnostics/support-bundle';
import { RuntimeDisposalFailure, RuntimeExecutionFailure } from '../runtime-failure';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';
import { readyGate } from './fixtures/start-ready';
import { connectControlClient } from '../daemon/control-client';
import type { ControlStatusResult } from '../daemon/control-protocol';
import { DEFAULT_AGENT_EGRESS_POLICY } from '../daemon/agent-egress-policy';

// A sessionless v3 Agent offer is a fresh one in v4, and a fresh offer carries the egress policy.
const FRESH_OFFER = { session: { mode: 'fresh' as const }, egressPolicy: DEFAULT_AGENT_EGRESS_POLICY };

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

  it('writes every record to the audit log and the identical JSON line to stdout, then stops cleanly on abort', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const storeDir = await tmpDir('byok-start-store-');
    daemon = createDaemonWithAdapters(
      { storage: { scratchRoot: testScratchRoot() },
        localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme',
        productId: 'acme-start-product',
        serverUrl: server.url,
        agentHome: testAgentHomeConfig(), agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },
        storeDir,
        branding: { displayName: 'Acme Coder' },
      },
      [adapter],
    );
    await daemon.pair('pairing-code');

    const lines: string[] = [];
    const controller = new AbortController();
    const gate = readyGate();

    const startPromise = runStartCommand(
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme', productId: 'acme-start-product', serverUrl: server.url, storeDir, branding: { displayName: 'Acme Coder' } },
      {
        daemon,
        log: (l) => lines.push(l),
        error: (l) => lines.push(`ERR: ${l}`),
        signal: controller.signal,
        onReady: gate.onReady,
      },
    );

    await gate.ready(startPromise);
    expect(lines.map((l) => JSON.parse(l) as DaemonRecord)).toContainEqual(
      expect.objectContaining({ kind: 'daemon-started', productId: 'acme-start-product' }),
    );

    // Drive one task through so the audit log picks up task-lifecycle events too.
    server.send(
      createEnvelope(
        'task.offer',
        { agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: 'do the thing' },
        { taskId: 'task-1', seq: server.nextSeq() },
      ),
    );
    await server.waitFor((e) => e.type === 'task.started');
    await vi.waitFor(() => expect(adapter.sessions).toHaveLength(1));
    adapter.sessions[0]?.emit({ type: 'turn_end' });
    await server.waitFor((e) => e.type === 'task.complete');

    await vi.waitFor(async () => {
      const events = await readAuditRecords(storeDir);
      expect(events.some((e) => e.kind === 'completed' && e.taskId === 'task-1')).toBe(true);
    });

    const auditEvents = await readAuditRecords(storeDir);
    expect(auditEvents.some((e) => e.kind === 'lifecycle')).toBe(true);
    expect(auditEvents.some((e) => e.kind === 'runtimes-detected')).toBe(true);
    expect(auditEvents.some((e) => e.kind === 'claimed' && e.taskId === 'task-1')).toBe(true);

    expect(lines.map((l) => JSON.parse(l) as DaemonRecord)).toContainEqual(expect.objectContaining({ kind: 'completed', taskId: 'task-1' }));

    controller.abort();
    await startPromise;
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ kind: 'daemon-stopped' });
    // Issue #395: stdout is JSON Lines, byte-for-byte the audit log's lines.
    expect(lines).toEqual((await fs.readFile(auditLogPath(storeDir), 'utf8')).trimEnd().split('\n'));
  });

  it('an audit-log write failure is reported via error() but does not stop the daemon from starting', async () => {
    const adapter = new StubRuntimeAdapter('pi');
    const parent = await tmpDir('byok-start-store-badlog-parent-');
    // storeDir itself is a FILE, not a directory — every audit append's own
    // `fs.mkdir(storeDir, {recursive:true})` will reject.
    const storeDir = path.join(parent, 'SENTINEL-395-audit-not-a-directory');
    await fs.writeFile(storeDir, 'x');

    daemon = createDaemonWithAdapters(
      {agentHome: testAgentHomeConfig(), agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY }, storage: { scratchRoot: testScratchRoot() }, localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme', productId: 'acme-start-badlog', serverUrl: server.url, storeDir: parent },
      [adapter],
    );
    // Daemon itself uses `parent` (a real dir) for its OWN device store, but
    // we pass the broken `storeDir` to runStartCommand's audit-log resolution
    // by overriding config.storeDir — see below.
    await daemon.pair('pairing-code');

    const lines: string[] = [];
    const controller = new AbortController();
    const gate = readyGate();

    const startPromise = runStartCommand(
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme', productId: 'acme-start-badlog', serverUrl: server.url, storeDir },
      {
        daemon,
        log: (l) => lines.push(l),
        error: (l) => lines.push(`ERR: ${l}`),
        signal: controller.signal,
        onReady: gate.onReady,
      },
    );

    await gate.ready(startPromise);
    await vi.waitFor(() => expect(lines.some((l) => l.startsWith('ERR: audit log append failed'))).toBe(true));

    controller.abort();
    await startPromise;
    const diagnostics = lines.filter((line) => line.startsWith('ERR:'));
    expect(diagnostics.every((line) => /Error reasonBytes=\d+/.test(line))).toBe(true);
    expect(diagnostics.join('\n')).not.toContain('SENTINEL-395');
  });

  it('#395 sentinel: no task content reaches stdout, stderr, audit.jsonl or the support bundle', async () => {
    const SENTINEL = 'SENTINEL-395';
    const adapter = new StubRuntimeAdapter('pi', { kind: 'available', version: SENTINEL });
    const storeDir = await tmpDir('byok-start-store-sentinel-');
    const config = {
      storage: { scratchRoot: testScratchRoot() },
      localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme', productId: 'acme-start-sentinel', serverUrl: server.url, storeDir, agentHome: testAgentHomeConfig(), agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY },
    };
    daemon = createDaemonWithAdapters(config, [adapter]);
    await daemon.pair('pairing-code');

    const stdout: string[] = [];
    const stderr: string[] = [];
    const capture = (sink: string[]) => (...args: unknown[]) => {
      sink.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack ?? ''}` : String(arg))).join(' '));
    };
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(capture(stdout)),
      vi.spyOn(console, 'error').mockImplementation(capture(stderr)),
      vi.spyOn(console, 'warn').mockImplementation(capture(stderr)),
    ];
    const controller = new AbortController();
    const gate = readyGate();
    try {
      const startPromise = runStartCommand(config, {
        daemon, log: (l) => stdout.push(l), error: (l) => stderr.push(l), signal: controller.signal, onReady: gate.onReady,
      });
      await gate.ready(startPromise);
      const connection = await connectControlClient({ storeDir, productId: config.productId });
      if (!connection.ok) throw new Error('expected the authenticated live control socket');
      try {
        const live = await connection.client.request<ControlStatusResult>('status');
        expect(live.runtimes?.find(runtime => runtime.id === 'pi')?.version).toBe(SENTINEL);
      } finally {
        connection.client.close();
      }
      const offer = (taskId: string) => server.send(createEnvelope('task.offer', { agentRef: freshTestAgentRef(), ...FRESH_OFFER, instruction: `do ${SENTINEL}` }, { taskId, seq: server.nextSeq() }));

      // Content in every AgentEvent field, an artifact that exists (name and
      // inline bytes) and one that does not (its name reaches the error
      // path), then a completed summary built from the run's text.
      offer('task-1');
      await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-1');
      expect(adapter.sessions).toHaveLength(1);
      await fs.writeFile(path.join(adapter.startCalls[0]!.ctx.workspaceDir, `${SENTINEL}.txt`), SENTINEL);
      const first = adapter.sessions[0]!;
      first.emit({ type: 'progress', text: SENTINEL });
      first.emit({ type: 'tool_use', tool: 'bash', input: { command: SENTINEL } });
      first.emit({ type: 'tool_result', tool: 'bash', output: SENTINEL });
      first.emit({ type: 'artifact', name: `${SENTINEL}.txt`, contentType: 'text/plain' });
      first.emit({ type: 'artifact', name: `${SENTINEL}-missing.txt`, contentType: 'text/plain' });
      first.emit({ type: 'error', message: SENTINEL });
      first.emit({ type: 'turn_end' });
      await server.waitFor((e) => e.type === 'task.complete' && e.task_id === 'task-1');

      // An untyped adapter failure whose error object carries content.
      offer('task-2');
      await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-2');
      expect(adapter.sessions).toHaveLength(2);
      adapter.sessions[1]!.fail(new Error(SENTINEL));
      await server.waitFor((e) => e.type === 'task.fail' && e.task_id === 'task-2');

      // An approval summary, then a typed failure whose reason is content.
      offer('task-3');
      await server.waitFor((e) => e.type === 'task.started' && e.task_id === 'task-3');
      expect(adapter.sessions).toHaveLength(3);
      void adapter.sessions[2]!.requestApproval(SENTINEL);
      await vi.waitFor(async () => expect((await readAuditRecords(storeDir)).some((r) => r.kind === 'awaiting-approval')).toBe(true));
      adapter.sessions[2]!.fail(new RuntimeExecutionFailure({ phase: 'run', category: 'semantic', retry: 'non-retryable', reason: SENTINEL }));
      await server.waitFor((e) => e.type === 'task.fail' && e.task_id === 'task-3');
      await vi.waitFor(async () => expect((await readAuditRecords(storeDir)).filter((r) => r.kind === 'failed')).toHaveLength(2));

      controller.abort();
      await startPromise;
    } finally {
      for (const spy of spies) spy.mockRestore();
    }

    const audit = await fs.readFile(auditLogPath(storeDir), 'utf8');
    const kinds = new Set((await readAuditRecords(storeDir)).map((record) => record.kind));
    for (const kind of ['turn', 'artifact', 'awaiting-approval', 'completed', 'failed'] as const) expect(kinds).toContain(kind);
    const bundle = await createSupportBundle(config, storeDir, { adapters: [], connectControl: async () => ({ ok: false, reason: 'offline' }) });
    for (const [sink, text] of [['stdout', stdout.join('\n')], ['stderr', stderr.join('\n')], ['audit.jsonl', audit], ['support bundle', JSON.stringify(bundle)]] as const) {
      expect(text.includes(SENTINEL), `${sink} must not carry task content`).toBe(false);
    }
    // The task content did flow on the wire to the server — it is only kept out of the durable sinks.
    expect(server.received.some((e) => JSON.stringify(e).includes(SENTINEL))).toBe(true);
  });

  it('#395: disposal failure stderr contains only its stage and byte count while the original error propagates', async () => {
    const failure = new RuntimeDisposalFailure({ stage: 'cleanup', reason: 'SENTINEL-395-清理' });
    const listeners = new Set<DaemonEventListener>();
    const stop = vi.fn().mockRejectedValue(failure);
    const fakeDaemon: Daemon = {
      pair: vi.fn(), start: vi.fn().mockResolvedValue(undefined), stop,
      status: vi.fn(), reloadMcpToolsets: vi.fn(), reportMcpToolsetObservation: vi.fn(),
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); },
      tasks: () => [], unpair: vi.fn(), approve: vi.fn(), reject: vi.fn(),
    };
    const storeDir = await tmpDir('byok-start-store-disposal-');
    const controller = new AbortController();
    controller.abort();
    const stderr: string[] = [];
    await expect(runStartCommand(
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme', productId: 'acme-start-disposal', serverUrl: 'http://example.invalid', storeDir },
      { daemon: fakeDaemon, log: () => {}, error: (line) => stderr.push(line), signal: controller.signal },
    )).rejects.toBe(failure);
    expect(stderr).toEqual([`cleanup failed during shutdown: RuntimeDisposalFailure stage=cleanup reasonBytes=${Buffer.byteLength(failure.message, 'utf8')}`]);
    expect(stderr.join('\n')).not.toContain('SENTINEL-395');
    expect(formatStartErrorReason(failure)).toBe(`RuntimeDisposalFailure stage=cleanup reasonBytes=${Buffer.byteLength(failure.message, 'utf8')}`);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(listeners.size).toBe(0);
  });

  it('#395: an unknown error name or stack cannot bypass the start diagnostic projection', () => {
    const error = new Error('SENTINEL-395');
    error.name = 'SENTINEL-395-name';
    error.stack = 'SENTINEL-395-stack';
    expect(formatStartErrorReason(error)).toBe('Error reasonBytes=12');
    expect(formatStartErrorReason('SENTINEL-395')).toBe('UnknownError reasonBytes=12');
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
        { localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme', productId: 'acme-start-throw', serverUrl: 'http://example.invalid', storeDir },
        { daemon: fakeDaemon, signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/boom-start/);

    expect(stop).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0); // unsubscribed
  });

  it('#394: a revoked device ends start as halted/device_revoked after one authentication, recorded in the audit log', async () => {
    const storeDir = await tmpDir('byok-start-store-revoked-');
    daemon = createDaemonWithAdapters(
      {agentHome: testAgentHomeConfig(), agentEgress: { policy: DEFAULT_AGENT_EGRESS_POLICY }, storage: { scratchRoot: testScratchRoot() }, localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme', productId: 'acme-start-revoked', serverUrl: server.url, storeDir },
      [new StubRuntimeAdapter('pi')],
    );
    const record = await daemon.pair('pairing-code');
    server.revokeDevice(record.deviceId);
    const challengesBefore = server.httpRequests.filter((request) => request.pathname === '/byok/challenge').length;
    const errors: string[] = [];

    const outcome = await runStartCommand(
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme', productId: 'acme-start-revoked', serverUrl: server.url, storeDir },
      { daemon, log: () => {}, error: (line) => errors.push(line), signal: new AbortController().signal },
    );

    expect(outcome).toEqual({ kind: 'halted', reason: 'device_revoked' });
    expect(daemonExitCode(outcome, false)).toBe(78);
    expect(daemonExitCode(outcome, true)).toBe(0);
    expect(server.httpRequests.filter((request) => request.pathname === '/byok/challenge').length - challengesBefore).toBe(1);
    expect(errors.some((line) => line.startsWith('daemon halted: reason=device_revoked'))).toBe(true);
    const audit = await readAuditRecords(storeDir);
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
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme', productId: 'acme-start-unpaired', serverUrl: 'http://example.invalid', storeDir },
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
      { localAgentRelease: { version: '0.0.0-test' }, productName: 'Acme', productId: 'acme-start-crashed', serverUrl: 'http://example.invalid', storeDir },
      { daemon: fakeDaemon, log: () => {}, error: () => {}, signal: new AbortController().signal },
    )).rejects.toBeInstanceOf(DaemonCrashedError);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(0);
    const audit = await readAuditRecords(storeDir);
    expect(audit.filter((record) => record.kind === 'lifecycle').at(-1)).toMatchObject({ lifecycle: { phase: 'crashed' } });
  });
});
