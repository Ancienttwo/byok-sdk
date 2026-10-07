import { spawn as realSpawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '@byok-sdk/protocol';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import type { SpawnFn } from '../adapters/claude/process-client';
import { CodexAdapter, type CodexAdapterOptions } from '../adapters/codex/codex-adapter';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { createDaemonWithAdapters, type Daemon } from '../daemon/create-daemon';
import type { Session } from '../types';
import { observationOf } from './fixtures/mcp-observation';
import { startPreparedOperation, type PreparedOperationResources } from './fixtures/prepared-operation';
import { StubRuntimeAdapter } from './fixtures/stub-adapter';
import { TestServer } from './fixtures/test-server';

/**
 * Minimal guardrails: no PermissionPolicy reaches a runtime. Each bundled
 * adapter launches without a permission mode or a per-tool grant, and still
 * projects the task's MCP servers. The daemon accepts an offer that carries
 * no policy. Each adapter inherits the user's own agent configuration: Claude
 * MCP config, Pi extensions and skills, and (with `inherit`) the Codex
 * sandbox.
 */

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const CLAUDE_NATIVE = fileURLToPath(new URL('./fixtures/claude-native-interactions.mjs', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
const FAKE_PI = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));

const sessions: Session[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function resources(env: NodeJS.ProcessEnv): Promise<PreparedOperationResources> {
  return {
    workspaceDir: await tempDir('byok-minimal-guardrails-'),
    env,
    mcpServers: { salesko: { command: process.execPath, args: ['/opt/salesko/fake-mcp.mjs'] } },
    mcpToolsetTools: observationOf({ salesko: ['find_leads'] }),
  };
}

function capturing(argv: string[][]): SpawnFn {
  return ((command: string, args: readonly string[] = [], options: object = {}) => {
    argv.push([...args]);
    return realSpawn(command, [...args], options);
  }) as unknown as SpawnFn;
}

async function drainTurn(session: Session): Promise<void> {
  for await (const event of session.events) if (event.type === 'turn_end') return;
}

describe('Claude launch', () => {
  it('skips permissions on the ordinary launch, with no mode, no tool list and the MCP config mounted', async () => {
    const argv: string[][] = [];
    const adapter = new ClaudeAdapter({ resolveBin: () => ({ command: FAKE_CLAUDE, source: 'path' }), spawnFn: capturing(argv) });
    const session = await startPreparedOperation(adapter, { instruction: 'say hi' }, await resources(process.env));
    sessions.push(session);

    const args = argv[0] ?? [];
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--permission-mode');
    expect(args).not.toContain('--tools');
    expect(args).not.toContain('--allowedTools');
    expect(args).not.toContain('--permission-prompt-tool');
    expect(args).toContain('--mcp-config');
    expect(args).not.toContain('--strict-mcp-config');
  });

  it('keeps the native interaction launch on the stdio prompt tool, without the skip flag', async () => {
    const directory = await tempDir('byok-minimal-guardrails-native-');
    const transcript = path.join(directory, 'transcript.jsonl');
    const adapter = new ClaudeAdapter({
      resolveBin: () => ({ command: CLAUDE_NATIVE, source: 'path' }),
      nativeInteractions: { onRequest: () => {} },
    });
    const session = await startPreparedOperation(adapter, { instruction: 'native launch' }, {
      workspaceDir: directory,
      env: { ...process.env, CLAUDE_NATIVE_SCENARIO: 'turn-end', CLAUDE_NATIVE_TRANSCRIPT: transcript },
    });
    sessions.push(session);

    const frames = (await fs.readFile(transcript, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { argv?: string[] });
    const args = frames.find((frame) => frame.argv !== undefined)?.argv ?? [];
    expect(args[args.indexOf('--permission-prompt-tool') + 1]).toBe('stdio');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits');
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--tools');
    expect(args).not.toContain('--allowedTools');
  });
});

describe('Codex launch', () => {
  it('projects MCP servers without a per-tool grant and starts the thread with approvalPolicy never', async () => {
    const argv: string[][] = [];
    const receiptDir = await tempDir('byok-minimal-guardrails-codex-');
    const receipt = path.join(receiptDir, 'frames.jsonl');
    const adapter = new CodexAdapter({
      resolveBin: () => ({ command: FAKE_CODEX, source: 'path' }),
      spawnFn: ((command: string, args: string[], options: Parameters<typeof realSpawn>[2]) => {
        argv.push([...args]);
        return realSpawn(command, args, options);
      }) as typeof realSpawn,
    });
    const session = await startPreparedOperation(adapter, { instruction: 'hello' }, await resources({
      PATH: process.env.PATH, HOME: os.homedir(), FAKE_CODEX_RPC_RECEIPT: receipt,
    }));
    sessions.push(session);
    await drainTurn(session);

    const args = argv[0] ?? [];
    expect(args.some((arg) => arg.startsWith('mcp_servers.salesko.command='))).toBe(true);
    expect(args.some((arg) => arg.includes('enabled_tools'))).toBe(false);
    expect(args.some((arg) => arg.includes('approval_mode'))).toBe(false);
    const frames = (await fs.readFile(receipt, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { method?: string; params?: { approvalPolicy?: string } });
    expect(frames.find((frame) => frame.method === 'thread/start')?.params?.approvalPolicy).toBe('never');
  });
});

describe('Codex sandbox', () => {
  async function launchArgs(sandbox: CodexAdapterOptions['sandbox']): Promise<string[]> {
    const argv: string[][] = [];
    const adapter = new CodexAdapter({
      resolveBin: () => ({ command: FAKE_CODEX, source: 'path' }),
      ...(sandbox === undefined ? {} : { sandbox }),
      spawnFn: ((command: string, args: string[], options: Parameters<typeof realSpawn>[2]) => {
        argv.push([...args]);
        return realSpawn(command, args, options);
      }) as typeof realSpawn,
    });
    const session = await startPreparedOperation(adapter, { instruction: 'hello' }, {
      workspaceDir: await tempDir('byok-minimal-guardrails-codex-sandbox-'),
      env: { PATH: process.env.PATH, HOME: os.homedir() },
    });
    sessions.push(session);
    await drainTurn(session);
    return argv[0] ?? [];
  }

  it.each([
    [undefined, 'sandbox_mode="danger-full-access"'],
    ['danger-full-access', 'sandbox_mode="danger-full-access"'],
    ['workspace-write', 'sandbox_mode="workspace-write"'],
    ['read-only', 'sandbox_mode="read-only"'],
  ] as const)('passes sandbox %s to app-server as %s', async (sandbox, expected) => {
    const args = await launchArgs(sandbox);
    expect(args.filter((arg) => arg.startsWith('sandbox_mode='))).toEqual([expected]);
    expect(args[args.indexOf(expected) - 1]).toBe('-c');
  });

  it('passes no sandbox override for inherit, so the user config.toml applies', async () => {
    const args = await launchArgs('inherit');
    expect(args).toContain('app-server');
    expect(args.some((arg) => arg.startsWith('sandbox_mode='))).toBe(false);
  });

  it('refuses an unknown sandbox value at construction', () => {
    expect(() => new CodexAdapter({ sandbox: 'yolo' as never })).toThrow(TypeError);
  });
});

describe('Pi launch', () => {
  it('passes no tool selection flags and writes a v4 launch config without policy', async () => {
    const argv: string[][] = [];
    const adapter = new PiAdapter({
      resolveBin: () => ({ command: FAKE_PI, source: 'env' }),
      spawnFn: ((_command: string, args: string[], options: Parameters<typeof realSpawn>[2]) => {
        argv.push([...args]);
        return realSpawn(FAKE_PI, args, options);
      }) as never,
    });
    const session = await startPreparedOperation(adapter, { instruction: 'hello' }, {
      workspaceDir: await tempDir('byok-minimal-guardrails-pi-'),
      env: process.env,
    });
    sessions.push(session);

    const args = argv[0] ?? [];
    expect(args).toContain('--mode');
    for (const flag of ['--tools', '--exclude-tools', '--no-tools', '--no-skills', '--no-extensions']) expect(args).not.toContain(flag);
    const config = JSON.parse(await fs.readFile(args[args.indexOf('--config') + 1]!, 'utf8')) as Record<string, unknown> & { mcp: Record<string, unknown> };
    expect(config).toMatchObject({ format: 'byok.pi.rpc-launch', version: 4 });
    expect(config).not.toHaveProperty('binding');
    expect(config).not.toHaveProperty('policy');
    expect(config.mcp).not.toHaveProperty('permissionMode');
  });
});

describe('daemon admission', () => {
  let server: TestServer | undefined;
  let daemon: Daemon | undefined;

  afterEach(async () => {
    await daemon?.stop();
    await server?.close();
    daemon = undefined;
    server = undefined;
  });

  it('claims and starts an offer that carries no policy', async () => {
    server = await TestServer.start();
    const adapter = new StubRuntimeAdapter();
    daemon = createDaemonWithAdapters(
      {
        localAgentRelease: { version: '0.0.0-test' }, productName: 'Test Product',
        productId: 'test-product',
        serverUrl: server.url,
        workspaceRoot: await tempDir('byok-minimal-guardrails-workspace-'),
        storeDir: await tempDir('byok-minimal-guardrails-store-'),
      },
      [adapter],
    );
    await daemon.pair('pairing-code');
    await daemon.start();

    const offer = createEnvelope('task.offer', { instruction: 'no policy' }, { taskId: 'task-no-policy', seq: server.nextSeq() });
    expect('policy' in offer.payload).toBe(false);
    server.send(offer);

    await server.waitFor((envelope) => envelope.type === 'task.claim' && envelope.task_id === 'task-no-policy');
    await server.waitFor((envelope) => envelope.type === 'task.started' && envelope.task_id === 'task-no-policy');
    expect(server.received.some((envelope) => envelope.type === 'task.decline')).toBe(false);
    expect(adapter.startCalls).toHaveLength(1);
    expect(adapter.startCalls[0]?.task.instruction).toBe('no policy');
    expect(adapter.startCalls[0]?.task).not.toHaveProperty('policy');
  });
});
