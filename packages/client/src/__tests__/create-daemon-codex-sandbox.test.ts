import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodexAdapterOptions } from '../adapters/codex/codex-adapter';
import { createDaemon, type DaemonConfig } from '../daemon/create-daemon';

/**
 * `DaemonConfig.codexSandbox` mirrors OAR's `OAR_CODEX_SANDBOX` for the
 * bundled Codex adapter. The recording subclass captures the options
 * `createDaemon` constructs the adapter with; the adapter's own argv
 * behavior is pinned in `minimal-guardrails-launch.test.ts`.
 */
const constructed = vi.hoisted(() => [] as CodexAdapterOptions[]);
vi.mock('../adapters/codex/codex-adapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../adapters/codex/codex-adapter')>();
  class RecordingCodexAdapter extends actual.CodexAdapter {
    constructor(options: CodexAdapterOptions = {}) {
      super(options);
      constructed.push(options);
    }
  }
  return { ...actual, CodexAdapter: RecordingCodexAdapter };
});

function config(extra: Partial<DaemonConfig> = {}): DaemonConfig {
  return {
    localAgentRelease: { version: '0.0.0-test' }, productName: 'Test',
    productId: 'codex-sandbox-config-test',
    serverUrl: 'http://127.0.0.1:1',
    workspaceRoot: path.join(os.tmpdir(), 'byok-codex-sandbox-workspaces'),
    storeDir: path.join(os.tmpdir(), 'byok-codex-sandbox-store'),
    runtimeAllowlist: ['codex'],
    ...extra,
  };
}

afterEach(() => { constructed.splice(0); });

describe('DaemonConfig.codexSandbox', () => {
  it('leaves the adapter default (danger-full-access) when unset', () => {
    createDaemon(config());
    expect(constructed).toHaveLength(1);
    expect(constructed[0]).not.toHaveProperty('sandbox');
  });

  it.each(['read-only', 'workspace-write', 'danger-full-access', 'inherit'] as const)('passes %s to the bundled Codex adapter', (codexSandbox) => {
    createDaemon(config({ codexSandbox }));
    expect(constructed).toHaveLength(1);
    expect(constructed[0]?.sandbox).toBe(codexSandbox);
  });

  it.each(['yolo', '', 'READ-ONLY', 1])('throws a TypeError for %j before any adapter is built', (codexSandbox) => {
    expect(() => createDaemon(config({ codexSandbox: codexSandbox as never }))).toThrow(TypeError);
    expect(() => createDaemon(config({ codexSandbox: codexSandbox as never }))).toThrow(/DaemonConfig\.codexSandbox must be one of/);
    expect(constructed).toHaveLength(0);
  });
});
