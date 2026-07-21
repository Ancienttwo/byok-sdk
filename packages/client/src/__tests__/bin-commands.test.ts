import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { Daemon, DaemonConfig, DeviceRecord, ServiceLifecycle } from '../index';
import { ControlError } from '../daemon/control-protocol';
import type { ConnectControlResult, ControlClient } from '../bin/control-client';
import { runApprovalsCommand } from '../bin/commands/approvals';
import { runApproveCommand, runRejectCommand } from '../bin/commands/approve-reject';
import { runPairCommand } from '../bin/commands/pair';
import { runRuntimesCommand } from '../bin/commands/runtimes';
import { runStatusCommand } from '../bin/commands/status';
import { runTasksFollowCommand, runTasksListCommand } from '../bin/commands/tasks';
import {
  runUnpairCommand,
  UnpairBlockedByRunningServiceError,
  UnpairExitUnconfirmedError,
  UnpairNotConfirmedError,
  UnpairUnknownDaemonStateError,
} from '../bin/commands/unpair';
import { appendAuditEvent, auditLogPath } from '../bin/audit-log';
import { DeviceStore } from '../daemon/store';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

/** Fake `connectControlClient` returning an unreachable result — the default for tests below that don't care about the live control socket. */
function fakeUnreachable(reason = 'daemon is not running (no control.token found)'): () => Promise<ConnectControlResult> {
  return async () => ({ ok: false, reason });
}

/** Fake `connectControlClient` returning a reachable client whose `request()` is driven by `handleRequest`. */
function fakeConnected(handleRequest: (method: string, params?: unknown) => Promise<unknown>): {
  connectControl: () => Promise<ConnectControlResult>;
  close: ReturnType<typeof vi.fn>;
} {
  const close = vi.fn();
  const client: ControlClient = {
    request: (method, params) => handleRequest(method, params) as never,
    subscribe: () => ({ close: vi.fn() }),
    close,
  };
  return { connectControl: async () => ({ ok: true, client }), close };
}

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function baseConfig(storeDir: string, overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    productName: 'Acme',
    productId: 'acme-product',
    serverUrl: 'http://example.invalid',
    workspaceRoot: '/ws',
    storeDir,
    ...overrides,
  };
}

function collectLog(): { log: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (line) => lines.push(line), lines };
}

/**
 * Shared by both the "confirmed running/not-running" tests and the
 * "residual" (round 3) indeterminate-query tests below — `determinate`
 * defaults to `true` (a clean, confirmed query) so every existing fixture
 * stays a "confirmed" result unchanged; the round-3 tests override it
 * explicitly to `false` (see `ServiceStatusResult.determinate`).
 */
function fakeLifecycle(status: {
  installed: boolean;
  running: boolean;
  detail: string;
  determinate?: boolean;
}): Pick<ServiceLifecycle, 'status'> {
  return { status: vi.fn().mockResolvedValue({ determinate: true, ...status }) };
}

describe('bin/commands/status: runStatusCommand', () => {
  it('reports unpaired, no connection, zero tasks, and branding when no state exists yet', async () => {
    const storeDir = await tmpDir('byok-cmd-status-empty-');
    const { log, lines } = collectLog();
    const config = baseConfig(storeDir, { branding: { displayName: 'Acme Coder' } });

    await runStatusCommand(config, { log, adapters: [new StubRuntimeAdapter('pi', { present: true, version: '1.0' })] });

    expect(lines[0]).toBe('product: Acme Coder (acme-product)');
    expect(lines.some((l) => l === 'paired: no')).toBe(true);
    expect(lines.some((l) => l.startsWith('connection: unknown'))).toBe(true);
    expect(lines.some((l) => l === 'tasks: total=0 offered=0 claimed=0 running=0 awaitApproval=0 complete=0 failed=0 cancelled=0')).toBe(
      true,
    );
    expect(lines.some((l) => l === 'runtimes: pi=present')).toBe(true);
  });

  it('reports paired:yes + deviceId once a device.json exists on disk — even though this Daemon was never start()ed', async () => {
    const storeDir = await tmpDir('byok-cmd-status-paired-');
    const record: DeviceRecord = {
      deviceId: 'dev-123',
      accessToken: 'tok',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      devicePrivateKeyPem: 'pem',
      devicePublicKey: 'pub',
    };
    await new DeviceStore(storeDir).save(record);

    const { log, lines } = collectLog();
    await runStatusCommand(baseConfig(storeDir), { log, adapters: [] });

    expect(lines.some((l) => l === 'paired: yes deviceId=dev-123')).toBe(true);
  });

  it('reflects task state and last-known connection derived from the audit log', async () => {
    const storeDir = await tmpDir('byok-cmd-status-audit-');
    await appendAuditEvent(storeDir, { kind: 'connection', ts: '2026-01-01T00:00:00.000Z', state: 'open' });
    await appendAuditEvent(storeDir, { kind: 'offered', ts: '2026-01-01T00:00:01.000Z', taskId: 't1', runtime: 'pi' });
    await appendAuditEvent(storeDir, { kind: 'claimed', ts: '2026-01-01T00:00:02.000Z', taskId: 't1' });

    const { log, lines } = collectLog();
    await runStatusCommand(baseConfig(storeDir), { log, adapters: [] });

    expect(lines.some((l) => l === 'connection: last-known=open at=2026-01-01T00:00:00.000Z')).toBe(true);
    expect(lines.some((l) => l === 'tasks: total=1 offered=0 claimed=1 running=0 awaitApproval=0 complete=0 failed=0 cancelled=0')).toBe(
      true,
    );
  });
});

describe('bin/commands/runtimes: runRuntimesCommand', () => {
  it('renders one line per probed adapter, using injected stub adapters', async () => {
    const { log, lines } = collectLog();
    await runRuntimesCommand(baseConfig('/unused'), {
      log,
      adapters: [
        new StubRuntimeAdapter('pi', { present: true, version: '1.2.3', authPresent: true }),
        new StubRuntimeAdapter('claude', { present: false }),
      ],
    });
    expect(lines).toEqual([
      'pi: present version=1.2.3 authPresent=true capabilities=steer,resume modes=auto,readonly',
      'claude: absent',
    ]);
  });
});

describe('bin/commands/tasks: runTasksListCommand', () => {
  it('shows a placeholder when the audit log has no events yet', async () => {
    const storeDir = await tmpDir('byok-cmd-tasks-empty-');
    const { log, lines } = collectLog();
    await runTasksListCommand(baseConfig(storeDir), { log });
    expect(lines).toEqual(['(no tasks observed yet)']);
  });

  it('lists tasks reconstructed from the audit log', async () => {
    const storeDir = await tmpDir('byok-cmd-tasks-list-');
    await appendAuditEvent(storeDir, { kind: 'offered', ts: '2026-01-01T00:00:00.000Z', taskId: 't1', runtime: 'pi' });
    await appendAuditEvent(storeDir, { kind: 'claimed', ts: '2026-01-01T00:00:01.000Z', taskId: 't1' });
    await appendAuditEvent(storeDir, { kind: 'started', ts: '2026-01-01T00:00:02.000Z', taskId: 't1' });
    await appendAuditEvent(storeDir, { kind: 'completed', ts: '2026-01-01T00:00:03.000Z', taskId: 't1', summary: 'done', sessionRef: 's1' });

    const { log, lines } = collectLog();
    await runTasksListCommand(baseConfig(storeDir), { log });
    // Finding P1 #3: `summary` is redacted on disk (never the raw "done"
    // text) — replayed from the audit log, this reconstructs to a
    // `[redacted: N bytes]` placeholder, not the original text. Full-fidelity
    // summaries are still available LIVE, directly off stdout, while
    // `byok-agent start` is actually running (see `bin/commands/start.ts`).
    expect(lines).toEqual([
      't1 Complete runtime=pi updatedAt=2026-01-01T00:00:03.000Z sessionRef=s1 summary="[redacted: 4 bytes]"',
    ]);
  });
});

describe('bin/commands/tasks: runTasksFollowCommand', () => {
  it('tails the audit log from its current end and stops on abort', async () => {
    const storeDir = await tmpDir('byok-cmd-tasks-follow-');
    // Pre-existing line before follow starts — must NOT be streamed (fromEnd semantics).
    await appendAuditEvent(storeDir, { kind: 'connection', ts: '2026-01-01T00:00:00.000Z', state: 'open' });

    const { log, lines } = collectLog();
    const controller = new AbortController();
    const followPromise = runTasksFollowCommand(baseConfig(storeDir), { log, signal: controller.signal, pollIntervalMs: 10 });

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(lines).toEqual([]); // pre-existing connection line correctly skipped

    await appendAuditEvent(storeDir, { kind: 'offered', ts: '2026-01-01T00:00:01.000Z', taskId: 't1', runtime: 'pi' });
    await vi.waitFor(() => expect(lines.length).toBeGreaterThanOrEqual(1));
    expect(lines[0]).toBe('[2026-01-01T00:00:01.000Z] offered taskId=t1 runtime=pi');

    controller.abort();
    await followPromise;
  });
});

describe('bin/commands/pair: runPairCommand', () => {
  it('calls daemon.pair(code) and logs the resulting deviceId', async () => {
    const pair = vi.fn().mockResolvedValue({ deviceId: 'dev-9' } as DeviceRecord);
    const { log, lines } = collectLog();
    await runPairCommand(baseConfig('/unused'), 'the-code', { log, daemon: { pair } });
    expect(pair).toHaveBeenCalledWith('the-code');
    expect(lines).toEqual(['paired: deviceId=dev-9']);
  });
});

describe('bin/commands/approve-reject (M4 Phase 2: control socket, not a live in-process Daemon)', () => {
  it('runApproveCommand calls approvals.resolve over the control socket and logs success', async () => {
    const handleRequest = vi.fn().mockResolvedValue({ resolved: true });
    const { connectControl, close } = fakeConnected(handleRequest);
    const { log, lines } = collectLog();

    await runApproveCommand('/store', 'acme-product', 'approval-1', { log, connectControl });

    expect(handleRequest).toHaveBeenCalledWith('approvals.resolve', { approvalId: 'approval-1', decision: 'approve', reason: undefined });
    expect(lines).toEqual(['approved: approvalId=approval-1']);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('runApproveCommand reports a clear, specific error (not an exception dump) when the daemon is unreachable', async () => {
    const errors: string[] = [];
    await expect(
      runApproveCommand('/store', 'acme-product', 'approval-1', {
        error: (l) => errors.push(l),
        connectControl: fakeUnreachable(),
      }),
    ).rejects.toThrow(/not reachable/);
    expect(errors.some((l) => l.includes('not reachable') && l.includes('approval-1'))).toBe(true);
  });

  it('runApproveCommand surfaces the registry not_found error message and rethrows, closing the connection either way', async () => {
    const handleRequest = vi.fn().mockRejectedValue(new ControlError('not_found', 'no pending approval with id "approval-x"'));
    const { connectControl, close } = fakeConnected(handleRequest);
    const errors: string[] = [];

    await expect(
      runApproveCommand('/store', 'acme-product', 'approval-x', { error: (l) => errors.push(l), connectControl }),
    ).rejects.toThrow(/no pending approval/);
    expect(errors.some((l) => l.includes('no pending approval'))).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('runRejectCommand calls approvals.resolve with the reason and logs success', async () => {
    const handleRequest = vi.fn().mockResolvedValue({ resolved: true });
    const { connectControl } = fakeConnected(handleRequest);
    const { log, lines } = collectLog();

    await runRejectCommand('/store', 'acme-product', 'approval-2', 'not allowed', { log, connectControl });

    expect(handleRequest).toHaveBeenCalledWith('approvals.resolve', { approvalId: 'approval-2', decision: 'reject', reason: 'not allowed' });
    expect(lines).toEqual(['rejected: approvalId=approval-2 reason="not allowed"']);
  });

  it('runRejectCommand works with no reason given', async () => {
    const handleRequest = vi.fn().mockResolvedValue({ resolved: true });
    const { connectControl } = fakeConnected(handleRequest);
    const { log, lines } = collectLog();

    await runRejectCommand('/store', 'acme-product', 'approval-3', undefined, { log, connectControl });

    expect(handleRequest).toHaveBeenCalledWith('approvals.resolve', { approvalId: 'approval-3', decision: 'reject', reason: undefined });
    expect(lines).toEqual(['rejected: approvalId=approval-3']);
  });
});

describe('bin/commands/approvals: runApprovalsCommand (finding F4)', () => {
  it('renders registry entries end-to-end via the control socket — approvalId, taskId, age, and a quoted summary excerpt per line', async () => {
    const handleRequest = vi.fn().mockResolvedValue({
      approvals: [
        { approvalId: 'appr-1', taskId: 't1', summary: 'Bash: rm -rf /tmp/x', createdAt: '2026-01-01T00:00:00.000Z' },
        { approvalId: 'appr-2', taskId: 't2', createdAt: '2026-01-01T00:00:30.000Z' },
      ],
    });
    const { connectControl, close } = fakeConnected(handleRequest);
    const { log, lines } = collectLog();

    await runApprovalsCommand('/store', 'acme-product', {
      log,
      connectControl,
      now: () => Date.parse('2026-01-01T00:01:00.000Z'),
    });

    expect(handleRequest).toHaveBeenCalledWith('approvals.list', undefined);
    expect(lines).toEqual([
      'appr-1 taskId=t1 age=1m summary="Bash: rm -rf /tmp/x"',
      'appr-2 taskId=t2 age=30s summary="(no summary)"',
    ]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('shows a placeholder line when there are no pending approvals', async () => {
    const handleRequest = vi.fn().mockResolvedValue({ approvals: [] });
    const { connectControl } = fakeConnected(handleRequest);
    const { log, lines } = collectLog();

    await runApprovalsCommand('/store', 'acme-product', { log, connectControl });

    expect(lines).toEqual(['(no pending approvals)']);
  });

  it('reports a clear, specific error (not an exception dump) when the daemon is unreachable', async () => {
    const errors: string[] = [];
    await expect(
      runApprovalsCommand('/store', 'acme-product', {
        error: (l) => errors.push(l),
        connectControl: fakeUnreachable(),
      }),
    ).rejects.toThrow(/not reachable/);
    expect(errors.some((l) => l.includes('not reachable') && l.includes('approvals'))).toBe(true);
  });

  it('surfaces a control error and rethrows, closing the connection either way', async () => {
    const handleRequest = vi.fn().mockRejectedValue(new ControlError('internal_error', 'boom'));
    const { connectControl, close } = fakeConnected(handleRequest);
    const errors: string[] = [];

    await expect(
      runApprovalsCommand('/store', 'acme-product', { error: (l) => errors.push(l), connectControl }),
    ).rejects.toThrow(/boom/);
    expect(errors.some((l) => l.includes('boom'))).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('bin/commands/unpair: runUnpairCommand', () => {
  // These first four tests exercise the CONFIRMATION flow in isolation —
  // `force: true` keeps them decoupled from the lifecycle/service-state
  // gate (finding P1 #2 residual, its own describe block below), which
  // would otherwise refuse before ever reaching the confirmation check
  // since no `lifecycle` is supplied here.
  it('with confirmed:true (i.e. --yes), calls daemon.unpair() without prompting', async () => {
    const unpair = vi.fn().mockResolvedValue(undefined);
    const { log, lines } = collectLog();
    await runUnpairCommand({ unpair }, { confirmed: true, force: true, log });
    expect(unpair).toHaveBeenCalledTimes(1);
    expect(lines.some((l) => l.startsWith('unpaired:'))).toBe(true);
  });

  it('without confirmation and no TTY, throws UnpairNotConfirmedError WITHOUT calling daemon.unpair() (never hangs headless)', async () => {
    const unpair = vi.fn().mockResolvedValue(undefined);
    await expect(runUnpairCommand({ unpair }, { isTTY: false, force: true })).rejects.toThrow(UnpairNotConfirmedError);
    expect(unpair).not.toHaveBeenCalled();
  });

  it('with a TTY and an interactive "y" answer, calls daemon.unpair()', async () => {
    const unpair = vi.fn().mockResolvedValue(undefined);
    const input = new PassThrough();
    const output = new PassThrough();
    output.on('data', () => {}); // drain the prompt text
    const runPromise = runUnpairCommand({ unpair }, { isTTY: true, force: true, input, output });
    input.write('y\n');
    await runPromise;
    expect(unpair).toHaveBeenCalledTimes(1);
  });

  it('with a TTY and a declined ("n") answer, does not call daemon.unpair()', async () => {
    const unpair = vi.fn().mockResolvedValue(undefined);
    const input = new PassThrough();
    const output = new PassThrough();
    output.on('data', () => {});
    const runPromise = runUnpairCommand({ unpair }, { isTTY: true, force: true, input, output });
    input.write('n\n');
    await expect(runPromise).rejects.toThrow(UnpairNotConfirmedError);
    expect(unpair).not.toHaveBeenCalled();
  });

  describe('finding P1 #2: lifecycle-aware refusal against a running background service', () => {

    it('refuses (never calling daemon.unpair(), never even prompting) when the lifecycle reports the service running', async () => {
      const unpair = vi.fn().mockResolvedValue(undefined);
      const lifecycle = fakeLifecycle({ installed: true, running: true, detail: 'state = running' });

      // confirmed:true so a throw can only come from the running-service
      // check itself, never from the confirmation prompt.
      await expect(runUnpairCommand({ unpair }, { confirmed: true, lifecycle })).rejects.toThrow(
        UnpairBlockedByRunningServiceError,
      );
      expect(unpair).not.toHaveBeenCalled();
    });

    it('the refusal error message names the concrete remediation (service-stop) and includes the lifecycle detail', async () => {
      const unpair = vi.fn().mockResolvedValue(undefined);
      const lifecycle = fakeLifecycle({ installed: true, running: true, detail: 'state = running' });

      let caught: unknown;
      try {
        await runUnpairCommand({ unpair }, { confirmed: true, lifecycle });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(UnpairBlockedByRunningServiceError);
      const message = (caught as Error).message;
      expect(message).toContain('service-stop');
      expect(message).toContain('state = running');
    });

    it('--force does NOT bypass a CONFIRMED running service — that block is unconditional', async () => {
      const unpair = vi.fn().mockResolvedValue(undefined);
      const lifecycle = fakeLifecycle({ installed: true, running: true, detail: 'state = running' });

      await expect(runUnpairCommand({ unpair }, { confirmed: true, force: true, lifecycle })).rejects.toThrow(
        UnpairBlockedByRunningServiceError,
      );
      expect(unpair).not.toHaveBeenCalled();
    });

    it('proceeds normally (no --force needed) when the lifecycle reports installed but NOT running', async () => {
      const unpair = vi.fn().mockResolvedValue(undefined);
      const lifecycle = fakeLifecycle({ installed: true, running: false, detail: 'state = stopped' });

      await runUnpairCommand({ unpair }, { confirmed: true, lifecycle });
      expect(unpair).toHaveBeenCalledTimes(1);
    });

    it('proceeds normally (no --force needed) when the lifecycle reports no service installed at all', async () => {
      const unpair = vi.fn().mockResolvedValue(undefined);
      const lifecycle = fakeLifecycle({ installed: false, running: false, detail: '' });

      await runUnpairCommand({ unpair }, { confirmed: true, lifecycle });
      expect(unpair).toHaveBeenCalledTimes(1);
    });

    it('the success message always calls out the foreground-process residual gap, when the service state was confirmed not-running', async () => {
      const unpair = vi.fn().mockResolvedValue(undefined);
      const { log, lines } = collectLog();
      const lifecycle = fakeLifecycle({ installed: false, running: false, detail: '' });

      await runUnpairCommand({ unpair }, { confirmed: true, lifecycle, log });
      expect(lines.some((l) => l.includes('foreground') && l.includes('re-write device.json'))).toBe(true);
    });
  });

  describe('finding P1 #2 residual (now fixed across rounds 1 and 3): fail-CLOSED, not open, when the daemon state cannot be confirmed', () => {
    it('refuses (never calling daemon.unpair()) when no lifecycle was supplied at all — this used to fail OPEN', async () => {
      const unpair = vi.fn().mockResolvedValue(undefined);

      await expect(runUnpairCommand({ unpair }, { confirmed: true })).rejects.toThrow(UnpairUnknownDaemonStateError);
      expect(unpair).not.toHaveBeenCalled();
    });

    it('the refusal message is actionable: mentions --force and that a running daemon could re-write the credential', async () => {
      const unpair = vi.fn().mockResolvedValue(undefined);

      let caught: unknown;
      try {
        await runUnpairCommand({ unpair }, { confirmed: true });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(UnpairUnknownDaemonStateError);
      const message = (caught as Error).message;
      expect(message).toContain('--force');
      expect(message).toContain('re-writing');
    });

    it('--force proceeds anyway when no lifecycle was supplied, and logs an explicit warning instead of the usual NOTE', async () => {
      const unpair = vi.fn().mockResolvedValue(undefined);
      const { log, lines } = collectLog();

      await runUnpairCommand({ unpair }, { confirmed: true, force: true, log });
      expect(unpair).toHaveBeenCalledTimes(1);
      expect(lines.some((l) => l.startsWith('unpaired:') && l.includes('WARNING') && l.includes('--force'))).toBe(true);
    });

    it('refuses (never calling daemon.unpair()) when the lifecycle\'s status() call itself rejects', async () => {
      const unpair = vi.fn().mockResolvedValue(undefined);
      const lifecycle: Pick<ServiceLifecycle, 'status'> = { status: vi.fn().mockRejectedValue(new Error('sc.exe not found')) };

      await expect(runUnpairCommand({ unpair }, { confirmed: true, lifecycle })).rejects.toThrow(UnpairUnknownDaemonStateError);
      expect(unpair).not.toHaveBeenCalled();
    });

    it('--force proceeds anyway when status() rejects, and still logs the warning', async () => {
      const unpair = vi.fn().mockResolvedValue(undefined);
      const lifecycle: Pick<ServiceLifecycle, 'status'> = { status: vi.fn().mockRejectedValue(new Error('sc.exe not found')) };
      const { log, lines } = collectLog();

      await runUnpairCommand({ unpair }, { confirmed: true, force: true, lifecycle, log });
      expect(unpair).toHaveBeenCalledTimes(1);
      expect(lines.some((l) => l.includes('WARNING') && l.includes('sc.exe not found'))).toBe(true);
    });

    describe('round 3: status() RESOLVES (does not throw) but the manager query itself was indeterminate', () => {
      it('refuses (never calling daemon.unpair(), never clearing the store) when status() resolves determinate=false on a bus-connect failure — this used to fail OPEN', async () => {
        const unpair = vi.fn().mockResolvedValue(undefined);
        const lifecycle = fakeLifecycle({
          installed: true,
          running: false,
          detail: 'Failed to connect to bus: No such file or directory',
          determinate: false,
        });

        await expect(runUnpairCommand({ unpair }, { confirmed: true, lifecycle })).rejects.toThrow(UnpairUnknownDaemonStateError);
        expect(unpair).not.toHaveBeenCalled();
      });

      it('refuses when status() resolves determinate=false on a permission-denied query', async () => {
        const unpair = vi.fn().mockResolvedValue(undefined);
        const lifecycle = fakeLifecycle({ installed: true, running: false, detail: 'Access denied', determinate: false });

        await expect(runUnpairCommand({ unpair }, { confirmed: true, lifecycle })).rejects.toThrow(UnpairUnknownDaemonStateError);
        expect(unpair).not.toHaveBeenCalled();
      });

      it('--force proceeds anyway when status() resolves indeterminate, and still logs the warning with the manager detail', async () => {
        const unpair = vi.fn().mockResolvedValue(undefined);
        const lifecycle = fakeLifecycle({
          installed: true,
          running: false,
          detail: 'Failed to connect to bus: No such file or directory',
          determinate: false,
        });
        const { log, lines } = collectLog();

        await runUnpairCommand({ unpair }, { confirmed: true, force: true, lifecycle, log });
        expect(unpair).toHaveBeenCalledTimes(1);
        expect(lines.some((l) => l.includes('WARNING') && l.includes('Failed to connect to bus'))).toBe(true);
      });

      it('a clean (determinate=true) not-installed/not-running result still proceeds without --force — this fix does not require --force universally', async () => {
        const unpair = vi.fn().mockResolvedValue(undefined);
        const lifecycle = fakeLifecycle({ installed: false, running: false, detail: '', determinate: true });

        await runUnpairCommand({ unpair }, { confirmed: true, lifecycle });
        expect(unpair).toHaveBeenCalledTimes(1);
      });

      it('a CONFIRMED running result still hard-blocks even when determinate=true is explicit — unconditional, same as the round-1 check', async () => {
        const unpair = vi.fn().mockResolvedValue(undefined);
        const lifecycle = fakeLifecycle({ installed: true, running: true, detail: 'state = running', determinate: true });

        await expect(runUnpairCommand({ unpair }, { confirmed: true, force: true, lifecycle })).rejects.toThrow(
          UnpairBlockedByRunningServiceError,
        );
        expect(unpair).not.toHaveBeenCalled();
      });
    });

    it('never even prompts for confirmation before refusing on an unknown state — same as the confirmed-running check', async () => {
      const unpair = vi.fn().mockResolvedValue(undefined);
      const input = new PassThrough();
      const output = new PassThrough();
      output.on('data', () => {});

      // No `confirmed`/`force` at all, plus an (unused) interactive TTY —
      // if the unknown-state refusal ran AFTER the confirmation prompt,
      // this would hang waiting on `input`. It must throw first.
      await expect(runUnpairCommand({ unpair }, { isTTY: true, input, output })).rejects.toThrow(UnpairUnknownDaemonStateError);
      expect(unpair).not.toHaveBeenCalled();
    });
  });

  describe('M4 Phase 2: live (control-socket) unpair path', () => {
    it('REGRESSION (gatekeeper-caught): closes the control-socket connection even when confirmation is declined, before rethrowing', async () => {
      const unpair = vi.fn().mockResolvedValue(undefined);
      const requestSpy = vi.fn();
      const { connectControl, close } = fakeConnected(requestSpy);

      await expect(
        runUnpairCommand(
          { unpair },
          { storeDir: '/store', productId: 'acme-product', isTTY: false, connectControl },
        ),
      ).rejects.toThrow(UnpairNotConfirmedError);

      expect(close).toHaveBeenCalledTimes(1); // used to leak: confirmUnpair() throwing skipped straight past conn.client.close()
      expect(requestSpy).not.toHaveBeenCalled(); // never got as far as sending shutdown
      expect(unpair).not.toHaveBeenCalled();
    });

    it('with confirmed:true, sends shutdown over the control socket and closes the connection', async () => {
      const unpair = vi.fn().mockResolvedValue(undefined);
      const requestSpy = vi.fn().mockResolvedValue({ acknowledged: true });
      const { connectControl, close } = fakeConnected(requestSpy);
      const isControlDaemonGone = vi.fn().mockResolvedValue(true);
      const { log, lines } = collectLog();

      await runUnpairCommand(
        { unpair },
        {
          storeDir: '/store',
          productId: 'acme-product',
          confirmed: true,
          connectControl,
          isControlDaemonGone,
          log,
        },
      );

      expect(requestSpy).toHaveBeenCalledWith('shutdown', { reason: 'unpair' });
      expect(close).toHaveBeenCalledTimes(1);
      expect(unpair).toHaveBeenCalledTimes(1);
      expect(lines.some((l) => l.includes('confirmed exited'))).toBe(true);
    });

    describe('finding F6: fail-closed when the daemon\'s exit is not confirmed', () => {
      it('refuses (never calling daemon.unpair(), leaving device.json intact) when isControlDaemonGone never confirms exit', async () => {
        const unpair = vi.fn().mockResolvedValue(undefined);
        const requestSpy = vi.fn().mockResolvedValue({ acknowledged: true });
        const { connectControl, close } = fakeConnected(requestSpy);
        const isControlDaemonGone = vi.fn().mockResolvedValue(false); // never confirms exit

        await expect(
          runUnpairCommand(
            { unpair },
            {
              storeDir: '/store',
              productId: 'acme-product',
              confirmed: true,
              connectControl,
              isControlDaemonGone,
              controlExitTimeoutMs: 30,
              controlExitPollIntervalMs: 10,
            },
          ),
        ).rejects.toThrow(UnpairExitUnconfirmedError);

        expect(unpair).not.toHaveBeenCalled(); // device.json left intact — the whole point of this fix
        expect(close).toHaveBeenCalledTimes(1); // the control-socket connection is still closed despite the later refusal
      });

      it('the refusal error message is actionable: mentions --force and that the daemon may still be running', async () => {
        const unpair = vi.fn().mockResolvedValue(undefined);
        const requestSpy = vi.fn().mockResolvedValue({ acknowledged: true });
        const { connectControl } = fakeConnected(requestSpy);
        const isControlDaemonGone = vi.fn().mockResolvedValue(false);

        let caught: unknown;
        try {
          await runUnpairCommand(
            { unpair },
            {
              storeDir: '/store',
              productId: 'acme-product',
              confirmed: true,
              connectControl,
              isControlDaemonGone,
              controlExitTimeoutMs: 30,
              controlExitPollIntervalMs: 10,
            },
          );
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(UnpairExitUnconfirmedError);
        const message = (caught as Error).message;
        expect(message).toContain('--force');
        expect(message).toMatch(/still be running/);
      });

      it('--force overrides an unconfirmed exit, clears device.json anyway, and logs an explicit WARNING', async () => {
        const unpair = vi.fn().mockResolvedValue(undefined);
        const requestSpy = vi.fn().mockResolvedValue({ acknowledged: true });
        const { connectControl } = fakeConnected(requestSpy);
        const isControlDaemonGone = vi.fn().mockResolvedValue(false);
        const { log, lines } = collectLog();

        await runUnpairCommand(
          { unpair },
          {
            storeDir: '/store',
            productId: 'acme-product',
            confirmed: true,
            force: true,
            connectControl,
            isControlDaemonGone,
            controlExitTimeoutMs: 30,
            controlExitPollIntervalMs: 10,
            log,
          },
        );

        expect(unpair).toHaveBeenCalledTimes(1);
        expect(lines.some((l) => l.includes('WARNING') && l.includes('did NOT confirm exit'))).toBe(true);
      });

      it('a CONFIRMED exit still proceeds without --force — this fix does not require --force universally', async () => {
        const unpair = vi.fn().mockResolvedValue(undefined);
        const requestSpy = vi.fn().mockResolvedValue({ acknowledged: true });
        const { connectControl } = fakeConnected(requestSpy);
        const isControlDaemonGone = vi.fn().mockResolvedValue(true);

        await runUnpairCommand(
          { unpair },
          {
            storeDir: '/store',
            productId: 'acme-product',
            confirmed: true,
            connectControl,
            isControlDaemonGone,
          },
        );

        expect(unpair).toHaveBeenCalledTimes(1);
      });
    });
  });
});

describe('bin/audit-log path used consistently by commands', () => {
  it('status/tasks read the SAME audit.jsonl path a command would append to', async () => {
    const storeDir = await tmpDir('byok-cmd-path-consistency-');
    const config = baseConfig(storeDir);
    expect(auditLogPath(storeDir)).toBe(path.join(storeDir, 'audit.jsonl'));
    await appendAuditEvent(storeDir, { kind: 'unpaired', ts: '2026-01-01T00:00:00.000Z' });
    const { log, lines } = collectLog();
    await runStatusCommand(config, { log, adapters: [] });
    expect(lines.some((l) => l.includes('(1 event)'))).toBe(true);
  });
});

// Type-only sanity: ensure the Daemon-shaped stubs used above stay structurally
// compatible with the real Daemon interface's relevant methods.
function _typeCheck(d: Daemon): void {
  void d.approve;
  void d.reject;
  void d.unpair;
  void d.pair;
}
void _typeCheck;
