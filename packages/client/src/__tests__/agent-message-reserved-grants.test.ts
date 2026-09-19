import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, TaskOfferPayload } from '@byok-sdk/protocol';
import { ClaudeAdapter } from '../adapters/claude/claude-adapter';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import type { Session } from '../types';
import { startPreparedOperation, type PreparedOperationResources } from './fixtures/prepared-operation';

/**
 * Adapter-level contract for the SDK-reserved Agent-message grant (#180),
 * the claude and pi counterparts of `codex-agent-message-permission.test.ts`.
 *
 * The reserved `byokagentmessage` server is granted per adapter through
 * `resolveReservedMcpToolGrants`, never through `PermissionPolicy.allowTools`
 * — a reserved lane is admitted by the offer's server projection. What each
 * runtime needs to actually receive that grant differs:
 *
 * - claude auto-denies an MCP tool missing from `--allowedTools`
 *   (`claude/permission-mapping.ts`), so the grant must appear as
 *   `mcp__byokagentmessage__send_agent_message` — the same shape the reserved
 *   memory tools already use.
 * - pi's `--tools` flag is a registry allowlist over builtin AND
 *   extension-registered tools alike (the fork's `_refreshToolRegistry`
 *   drops every tool the list does not name), and the SDK extension registers
 *   the reserved helpers under their bare protocol names, so the grant must
 *   appear as the bare `send_agent_message` inside any allowlist pi is
 *   handed. With no allowlist emitted (`auto`, no `allowTools`) the tool is
 *   authorized by the undefined allowlist itself and nothing is added.
 *
 * The final-text→Agent-message fallback and the one-message-body-per-turn
 * invariant are daemon-level behaviors pinned runtime-agnostically by
 * `agent-message-completion-gate.test.ts`; adapters only owe the grant and
 * the mounted server asserted here.
 */
const CLAUDE_FIXTURE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const PI_FIXTURE = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));

const sessions: Session[] = [];
const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close().catch(() => {})));
  await Promise.all(workspaces.splice(0).map((workspace) => fs.rm(workspace, { recursive: true, force: true })));
});

async function workspace(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  workspaces.push(dir);
  return dir;
}

function capturingSpawn(captured: string[][]) {
  return ((_command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
    captured.push([...args]);
    return spawn(_command, args, options);
  }) as never;
}

async function drain(session: Session, count: number): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of session.events) {
    events.push(event);
    if (events.length >= count) break;
  }
  return events;
}

async function startWith(
  adapter: ClaudeAdapter | PiAdapter,
  resources: PreparedOperationResources,
  instruction = 'publish one message',
): Promise<Session> {
  const task: TaskOfferPayload = { instruction, policy: resources.policy };
  const session = await startPreparedOperation(adapter, task, resources);
  sessions.push(session);
  return session;
}

/** The server the daemon projects for an offer carrying `messageEgress`. */
const MESSAGE_SERVER = {
  byokagentmessage: {
    command: '/opt/byok-agent-message-mcp',
    env: { BYOK_AGENT_MESSAGE_CONTEXT: 'sealed-context' },
  },
} as const;

describe('reserved Agent-message grant — claude', () => {
  it('pre-grants send_agent_message in the --allowedTools shape and mounts the server', async () => {
    const captured: string[][] = [];
    const adapter = new ClaudeAdapter({
      resolveBin: () => ({ command: CLAUDE_FIXTURE, source: 'path' }),
      spawnFn: capturingSpawn(captured),
    });
    const session = await startWith(adapter, {
      workspaceDir: await workspace('byok-claude-message-grant-'),
      policy: { mode: 'auto' },
      env: process.env,
      mcpServers: MESSAGE_SERVER,
    });
    await drain(session, 1);

    const argv = captured[0] ?? [];
    // Authorized: claude auto-denies an MCP tool missing from --allowedTools,
    // so this identifier is the difference between a callable tool and a
    // mounted-but-dead one.
    expect(argv[argv.indexOf('--allowedTools') + 1]).toBe('mcp__byokagentmessage__send_agent_message');
    // Delivered: the server itself rides the task-scoped --mcp-config, so the
    // granted identifier names a server claude actually spawns.
    const configPath = argv[argv.indexOf('--mcp-config') + 1];
    if (typeof configPath !== 'string') throw new Error('missing claude mcp config path');
    expect(JSON.parse(await fs.readFile(configPath, 'utf8')).mcpServers).toMatchObject({
      byokagentmessage: { env: { BYOK_AGENT_MESSAGE_CONTEXT: 'sealed-context' } },
    });
  });

  it('grants the reserved message tool beside the memory tools under readonly, exactly like codex', async () => {
    const captured: string[][] = [];
    const adapter = new ClaudeAdapter({
      resolveBin: () => ({ command: CLAUDE_FIXTURE, source: 'path' }),
      spawnFn: capturingSpawn(captured),
    });
    const session = await startWith(adapter, {
      workspaceDir: await workspace('byok-claude-message-readonly-'),
      policy: { mode: 'readonly', allowTools: [] },
      env: process.env,
      mcpServers: {
        ...MESSAGE_SERVER,
        byokagentmemory: { command: '/opt/byok-agent-memory-mcp' },
      },
    });
    await drain(session, 1);

    const argv = captured[0] ?? [];
    expect(argv[argv.indexOf('--tools') + 1]).toBe('');
    // One sorted identifier list from the whole reserved table — the memory
    // grants are unchanged, the message grant joins them, and nothing else
    // (no unobserved host-toolset name, no server wildcard) sneaks in.
    expect(argv[argv.indexOf('--allowedTools') + 1]).toBe(
      'mcp__byokagentmemory__memory_recall,mcp__byokagentmemory__memory_save'
      + ',mcp__byokagentmessage__send_agent_message',
    );
  });

  it('never grants the message identifier when the task did not project the server', async () => {
    const captured: string[][] = [];
    const adapter = new ClaudeAdapter({
      resolveBin: () => ({ command: CLAUDE_FIXTURE, source: 'path' }),
      spawnFn: capturingSpawn(captured),
    });
    const session = await startWith(adapter, {
      workspaceDir: await workspace('byok-claude-message-absent-'),
      policy: { mode: 'readonly', allowTools: [] },
      env: process.env,
      mcpServers: { byokagentmemory: { command: '/opt/byok-agent-memory-mcp' } },
    });
    await drain(session, 1);

    const argv = captured[0] ?? [];
    // Absence changes nothing: the memory grants keep their exact old shape
    // and the message identifier appears nowhere.
    expect(argv[argv.indexOf('--allowedTools') + 1]).toBe(
      'mcp__byokagentmemory__memory_recall,mcp__byokagentmemory__memory_save',
    );
  });
});

describe('reserved Agent-message grant — pi', () => {
  it('admits the bare send_agent_message into the readonly allowlist and writes the server into the task config', async () => {
    const captured: string[][] = [];
    const adapter = new PiAdapter({
      resolveBin: () => ({ command: PI_FIXTURE, source: 'env' }),
      spawnFn: capturingSpawn(captured),
    });
    const session = await startWith(adapter, {
      workspaceDir: await workspace('byok-pi-message-readonly-'),
      policy: { mode: 'readonly' },
      env: process.env,
      mcpServers: MESSAGE_SERVER,
    });

    const argv = captured[0] ?? [];
    // Authorized: pi's --tools allowlist drops extension-registered tools it
    // does not name, so the bare protocol name must ride the list.
    expect(argv[argv.indexOf('--tools') + 1]).toBe('read,grep,find,ls,subagent,todo,send_agent_message');
    // Delivered: the extension opens the server from this config and
    // registers its tools under those same bare names.
    const configPath = argv[argv.indexOf('--config') + 1];
    if (typeof configPath !== 'string') throw new Error('missing pi mcp config path');
    expect(JSON.parse(await fs.readFile(configPath, 'utf8')).mcp.mcpServers).toMatchObject({
      byokagentmessage: { env: { BYOK_AGENT_MESSAGE_CONTEXT: 'sealed-context' } },
    });
  });

  it('emits an explicit allowlist for readonly + allowTools:[] instead of --no-tools when the message lane is projected', async () => {
    const captured: string[][] = [];
    const adapter = new PiAdapter({
      resolveBin: () => ({ command: PI_FIXTURE, source: 'env' }),
      spawnFn: capturingSpawn(captured),
    });
    const session = await startWith(adapter, {
      workspaceDir: await workspace('byok-pi-message-readonly-empty-'),
      policy: { mode: 'readonly', allowTools: [] },
      env: process.env,
      mcpServers: MESSAGE_SERVER,
    });

    const argv = captured[0] ?? [];
    // --no-tools would leave the reserved tool's activation to pi's
    // new-registry-name bookkeeping; an allowlist naming exactly the granted
    // lane keeps every native off and the message tool on, explicitly.
    expect(argv).not.toContain('--no-tools');
    expect(argv[argv.indexOf('--tools') + 1]).toBe('send_agent_message');
  });

  it('appends the reserved name to an auto-mode allowTools list without widening the operator\'s own entries', async () => {
    const captured: string[][] = [];
    const adapter = new PiAdapter({
      resolveBin: () => ({ command: PI_FIXTURE, source: 'env' }),
      spawnFn: capturingSpawn(captured),
    });
    const session = await startWith(adapter, {
      workspaceDir: await workspace('byok-pi-message-auto-allowtools-'),
      policy: { mode: 'auto', allowTools: ['read', 'bash'] },
      env: process.env,
      mcpServers: MESSAGE_SERVER,
    });

    const argv = captured[0] ?? [];
    expect(argv[argv.indexOf('--tools') + 1]).toBe('read,bash,send_agent_message');
  });

  it('adds no --tools flag under auto without allowTools: the undefined allowlist already admits the extension tool', async () => {
    const captured: string[][] = [];
    const adapter = new PiAdapter({
      resolveBin: () => ({ command: PI_FIXTURE, source: 'env' }),
      spawnFn: capturingSpawn(captured),
    });
    const session = await startWith(adapter, {
      workspaceDir: await workspace('byok-pi-message-auto-open-'),
      policy: { mode: 'auto' },
      env: process.env,
      mcpServers: MESSAGE_SERVER,
    });

    const argv = captured[0] ?? [];
    // Emitting a list here would cage pi's native default registry to the
    // reserved names; with no list, pi admits every extension tool, the
    // reserved one included, so nothing needs to change.
    expect(argv).not.toContain('--tools');
    expect(argv).not.toContain('--no-tools');
  });

  it('keeps the readonly allowlist byte-identical when no reserved server is projected', async () => {
    const captured: string[][] = [];
    const adapter = new PiAdapter({
      resolveBin: () => ({ command: PI_FIXTURE, source: 'env' }),
      spawnFn: capturingSpawn(captured),
    });
    const session = await startWith(adapter, {
      workspaceDir: await workspace('byok-pi-message-absent-'),
      policy: { mode: 'readonly' },
      env: process.env,
    });

    const argv = captured[0] ?? [];
    expect(argv[argv.indexOf('--tools') + 1]).toBe('read,grep,find,ls,subagent,todo');
  });
});
