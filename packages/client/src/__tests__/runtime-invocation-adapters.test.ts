import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import type { Session } from '../types';
import { startPreparedOperation } from './fixtures/prepared-operation';

const fixtures = {
  claude: fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url)),
  codex: fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url)),
};

// What a Windows npm shim resolves to: node, with the shim's entry before the
// adapter's own arguments. Every platform can run this form.
vi.mock('../adapters/runtime-invocation', () => ({
  resolveRuntimeInvocation: vi.fn((command: string) => {
    // A raw Node read error: its message names the local shim path.
    if (command === 'unreadable-shim') throw Object.assign(new Error("EACCES: permission denied, open 'C:\\Users\\someone\\npm\\claude.cmd'"), { code: 'EACCES' });
    const runtime = /^npm-shim:(claude|codex)$/.exec(command)?.[1] as keyof typeof fixtures | undefined;
    if (runtime === undefined) throw new Error(`unexpected command ${command}`);
    return { command: process.execPath, args: [fixtures[runtime]] };
  }),
  runtimeInvocationHost: vi.fn(() => ({})),
}));

const sessions: Session[] = [];
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.close()));
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

function recordingSpawn() {
  const calls: Array<{ command: string; args: string[] }> = [];
  const spawnFn = ((command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
    calls.push({ command, args: [...args] });
    return spawn(command, args, options);
  }) as typeof spawn;
  return { calls, spawnFn };
}

async function resources() {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-runtime-invocation-'));
  dirs.push(workspaceDir);
  return { workspaceDir, env: { ...process.env } };
}

describe('adapters detect and launch through one resolved invocation (#763)', () => {
  it('claude', async () => {
    const { calls, spawnFn } = recordingSpawn();
    const adapter = new ClaudeAdapter({ resolveBin: () => ({ command: 'npm-shim:claude', source: 'path' }), spawnFn });
    expect(await adapter.detect()).toMatchObject({ kind: 'available' });
    sessions.push(await startPreparedOperation(adapter, { instruction: 'say hi' }, await resources()));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe(process.execPath);
    expect(calls[0]!.args.slice(0, 2)).toEqual([fixtures.claude, '-p']);
  });

  it('codex', async () => {
    const { calls, spawnFn } = recordingSpawn();
    const adapter = new CodexAdapter({ resolveBin: () => ({ command: 'npm-shim:codex', source: 'path' }), spawnFn });
    expect(await adapter.detect()).toMatchObject({ kind: 'available' });
    sessions.push(await startPreparedOperation(adapter, { instruction: 'hello' }, await resources()));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe(process.execPath);
    expect(calls[0]!.args[0]).toBe(fixtures.codex);
    expect(calls[0]!.args).toContain('app-server');
  });

  it('rejects a resolver failure the same way in both adapters, without a local path', async () => {
    const resolveBin = () => ({ command: 'unreadable-shim', source: 'path' as const });
    for (const [adapter, runtime] of [[new ClaudeAdapter({ resolveBin }), 'claude'], [new CodexAdapter({ resolveBin }), 'codex']] as const) {
      expect(await adapter.prepare({ offer: { instruction: 'x' } } as never))
        .toEqual({ kind: 'reject', reason: `${runtime} installation refused: not-executable`, retryable: false });
    }
  });
});
