import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { Daemon, DaemonConfig, DeviceRecord, ServiceLifecycle } from '../index';
import { runApproveCommand, runRejectCommand } from '../bin/commands/approve-reject';
import { runPairCommand } from '../bin/commands/pair';
import { runRuntimesCommand } from '../bin/commands/runtimes';
import { runStatusCommand } from '../bin/commands/status';
import { runTasksFollowCommand, runTasksListCommand } from '../bin/commands/tasks';
import { runUnpairCommand, UnpairBlockedByRunningServiceError, UnpairNotConfirmedError, UnpairUnknownDaemonStateError } from '../bin/commands/unpair';
import { appendAuditEvent, auditLogPath } from '../bin/audit-log';
import { DeviceStore } from '../daemon/store';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';

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

describe('bin/commands/approve-reject', () => {
  it('runApproveCommand calls daemon.approve(taskId) and logs success', async () => {
    const approve = vi.fn().mockResolvedValue(undefined);
    const { log, lines } = collectLog();
    await runApproveCommand({ approve }, 'task-1', { log });
    expect(approve).toHaveBeenCalledWith('task-1');
    expect(lines).toEqual(['approved: taskId=task-1']);
  });

  it('runApproveCommand prints the honest unexercised note and rethrows on failure', async () => {
    const approve = vi.fn().mockRejectedValue(new Error('daemon is not started; call start() first'));
    const errors: string[] = [];
    await expect(runApproveCommand({ approve }, 'task-1', { error: (l) => errors.push(l) })).rejects.toThrow(/not started/);
    expect(errors.some((l) => l.includes('ready-but-unexercised'))).toBe(true);
  });

  it('runRejectCommand calls daemon.reject(taskId, reason) and logs success', async () => {
    const reject = vi.fn().mockResolvedValue(undefined);
    const { log, lines } = collectLog();
    await runRejectCommand({ reject }, 'task-2', 'not allowed', { log });
    expect(reject).toHaveBeenCalledWith('task-2', 'not allowed');
    expect(lines).toEqual(['rejected: taskId=task-2 reason="not allowed"']);
  });

  it('runRejectCommand works with no reason given', async () => {
    const reject = vi.fn().mockResolvedValue(undefined);
    const { log, lines } = collectLog();
    await runRejectCommand({ reject }, 'task-3', undefined, { log });
    expect(reject).toHaveBeenCalledWith('task-3', undefined);
    expect(lines).toEqual(['rejected: taskId=task-3']);
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
