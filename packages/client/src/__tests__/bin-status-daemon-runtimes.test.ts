import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonConfig } from '../index';
import type { ConnectControlResult, ControlClient } from '../bin/control-client';
import { appendAuditEvent } from '../bin/audit-log';
import { runStatusCommand } from '../bin/commands/status';
import * as runtimeProbe from '../bin/runtime-probe';
import * as runtimeDetection from '../runtime-detection';

/**
 * Issue #392: `byok-agent status` reports the runtimes and environment the
 * DAEMON saw — online from its control `status`, offline from the last
 * `environment-resolved`/`runtimes-detected` events — and never probes a
 * runtime itself. Both probe entry points are wrapped so any call (adapter
 * construction through `defaultRuntimeAdapters`, a `probeRuntimes` pass, or a
 * direct `observeRuntimeDetection`) is visible.
 */
vi.mock('../bin/runtime-probe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../bin/runtime-probe')>();
  return { ...actual, defaultRuntimeAdapters: vi.fn(actual.defaultRuntimeAdapters), probeRuntimes: vi.fn(actual.probeRuntimes) };
});
vi.mock('../runtime-detection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime-detection')>();
  return { ...actual, observeRuntimeDetection: vi.fn(actual.observeRuntimeDetection) };
});

const dirs: string[] = [];

async function tmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.mocked(runtimeProbe.defaultRuntimeAdapters).mockClear();
  vi.mocked(runtimeProbe.probeRuntimes).mockClear();
  vi.mocked(runtimeDetection.observeRuntimeDetection).mockClear();
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function config(storeDir: string): DaemonConfig {
  return {
    localAgentRelease: { version: '0.0.0-test' },
    productName: 'Acme',
    productId: 'acme-status-runtimes',
    serverUrl: 'http://127.0.0.1:9',
    workspaceRoot: storeDir,
    storeDir,
  };
}

const LIVE = {
  pid: 7,
  uptimeMs: 1,
  paired: true,
  lifecycle: { phase: 'running', connection: 'open' },
  activeTasks: [],
  runtimes: [
    { id: 'claude', outcome: 'available', version: '2.1.0', authPresent: true },
    { id: 'codex', outcome: 'not-found' },
  ],
  environment: { source: 'login-shell', shell: 'zsh', durationMs: 530 },
  queueWatermarks: [],
  approvals: [],
  approvalsPending: 0,
  toolsets: { revision: `sha256:${'0'.repeat(64)}`, toolsets: [] },
  operationalHealth: { availability: 'available', state: 'healthy', failureCount: 0, windowMs: 60_000, failureThreshold: 3, crashCount: 0 },
};

function online(status: Record<string, unknown>): () => Promise<ConnectControlResult> {
  return () => {
    const client: ControlClient = {
      request: vi.fn().mockResolvedValue(status),
      subscribe: () => ({ close: vi.fn() }),
      close: vi.fn(),
    };
    return Promise.resolve({ ok: true, client });
  };
}

function offline(): Promise<ConnectControlResult> {
  return Promise.resolve({ ok: false, reason: 'daemon is not running' });
}

function expectNoProbe(): void {
  expect(runtimeProbe.defaultRuntimeAdapters).not.toHaveBeenCalled();
  expect(runtimeProbe.probeRuntimes).not.toHaveBeenCalled();
  expect(runtimeDetection.observeRuntimeDetection).not.toHaveBeenCalled();
}

describe('byok-agent status: the daemon\'s runtimes and environment (issue #392)', () => {
  it('online: renders the daemon\'s environment and per-runtime outcomes, and probes nothing', async () => {
    const storeDir = await tmpDir('byok-status-online-');
    // A stale offline event must not leak into the online view.
    await appendAuditEvent(storeDir, { kind: 'environment-resolved', ts: '2026-10-13T00:00:00.000Z', source: 'inherited' });
    const lines: string[] = [];
    await runStatusCommand(config(storeDir), { connectControl: online(LIVE), log: (line) => lines.push(line) });

    expect(lines).toContain('live-environment: login-shell shell=zsh durationMs=530');
    expect(lines).toContain('live-runtime: claude available version=2.1.0 authPresent=true');
    expect(lines).toContain('live-runtime: codex not-found');
    expect(lines.some((line) => line.startsWith('environment:') || line.startsWith('runtimes:'))).toBe(false);
    expectNoProbe();
  });

  it('offline: renders the last environment-resolved and runtimes-detected events with their times, and probes nothing', async () => {
    const storeDir = await tmpDir('byok-status-offline-');
    const empty: string[] = [];
    await runStatusCommand(config(storeDir), { connectControl: offline, log: (line) => empty.push(line) });
    expect(empty).toContain('environment: unknown (no environment-resolved event yet)');
    expect(empty).toContain('runtimes: unknown (no runtimes-detected event yet)');

    await appendAuditEvent(storeDir, { kind: 'environment-resolved', ts: '2026-10-13T00:00:00.000Z', source: 'inherited' });
    await appendAuditEvent(storeDir, { kind: 'runtimes-detected', ts: '2026-10-13T00:00:01.000Z', runtimes: [{ id: 'pi' }] });
    await appendAuditEvent(storeDir, { kind: 'environment-resolved', ts: '2026-10-13T00:01:00.000Z', source: 'login-shell', shell: 'bash', durationMs: 12 });
    await appendAuditEvent(storeDir, { kind: 'runtimes-detected', ts: '2026-10-13T00:01:01.000Z', runtimes: [{ id: 'claude' }, { id: 'codex' }] });
    const lines: string[] = [];
    await runStatusCommand(config(storeDir), { connectControl: offline, log: (line) => lines.push(line) });
    expect(lines).toContain('environment: last-known login-shell shell=bash durationMs=12 at=2026-10-13T00:01:00.000Z');
    expect(lines).toContain('runtimes: last-known available=claude,codex at=2026-10-13T00:01:01.000Z');
    expect(lines.some((line) => line.startsWith('live status: daemon not reachable'))).toBe(true);
    expectNoProbe();
  });

  it('transition: a still-running daemon from before #392 renders environment and runtimes as unknown, and probes nothing', async () => {
    const storeDir = await tmpDir('byok-status-old-daemon-');
    const { runtimes: _runtimes, environment: _environment, ...old } = LIVE;
    const lines: string[] = [];
    await runStatusCommand(config(storeDir), { connectControl: online(old), log: (line) => lines.push(line) });
    expect(lines).toContain('live-environment: unknown (daemon predates environment reporting)');
    expect(lines).toContain('live-runtime: unknown (daemon predates runtime outcome reporting)');
    expectNoProbe();
  });
});
