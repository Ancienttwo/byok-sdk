import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent, TaskOfferPayload } from '@byok-sdk/protocol';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import type { Session } from '../types';
import { startPreparedOperation, type PreparedOperationResources } from './fixtures/prepared-operation';

const FIXTURE_PATH = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
const sessions: Session[] = [];
const workspaces: string[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  await Promise.all(workspaces.splice(0).map((workspace) => fs.rm(workspace, { recursive: true, force: true })));
});

async function takeEvents(session: Session, count: number): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of session.events) {
    events.push(event);
    if (events.length === count) break;
  }
  return events;
}

describe('Codex reserved Agent-message permission composition', () => {
  it('approves only send_agent_message on the SDK-reserved server while global approval stays never', async () => {
    const captured: string[][] = [];
    const adapter = new CodexAdapter({
      resolveBin: () => ({ command: FIXTURE_PATH, source: 'path' }),
      spawnFn: ((command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
        captured.push([...args]);
        return spawn(command, args, options);
      }) as never,
    });
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-codex-message-permission-'));
    workspaces.push(workspaceDir);
    const resources: PreparedOperationResources = {
      workspaceDir,
      policy: { mode: 'auto' },
      env: process.env,
      mcpServers: {
        byokagentmessage: {
          command: '/opt/byok-agent-message-mcp',
          env: { BYOK_AGENT_MESSAGE_CONTEXT: 'sealed-context' },
        },
        productdocs: { command: '/opt/product-docs-mcp' },
      },
      mcpToolsetTools: { productdocs: ['search_docs'] },
    };
    const task: TaskOfferPayload = { instruction: 'publish one message', policy: { mode: 'auto' } };
    const session = await startPreparedOperation(adapter, task, resources);
    sessions.push(session);
    await takeEvents(session, 7);

    const argv = captured[0] ?? [];
    expect(argv).toContain('approval_policy=never');
    expect(argv).toContain('mcp_servers.byokagentmessage.enabled_tools=["send_agent_message"]');
    expect(argv).toContain('mcp_servers.byokagentmessage.tools.send_agent_message.approval_mode="approve"');
    // The reserved grant stays exactly one tool: a second server on the same
    // invocation gets its OWN observed tools and never widens the reserved
    // helper's allowlist (nor the global approval policy above).
    expect(argv).toContain('mcp_servers.productdocs.enabled_tools=["search_docs"]');
    expect(argv).toContain('mcp_servers.productdocs.tools.search_docs.approval_mode="approve"');
    expect(argv.some((arg) => arg.startsWith('mcp_servers.byokagentmessage.tools.') && !arg.startsWith('mcp_servers.byokagentmessage.tools.send_agent_message.'))).toBe(false);
    expect(argv.some((arg) => arg.startsWith('mcp_servers.productdocs.tools.') && !arg.startsWith('mcp_servers.productdocs.tools.search_docs.'))).toBe(false);
  });

  it('rejects before runtime spawn when the installed Codex lacks the native per-tool approval contract', async () => {
    const captured: string[][] = [];
    const adapter = new CodexAdapter({
      resolveBin: () => ({ command: FIXTURE_PATH, source: 'path' }),
      spawnFn: ((command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
        captured.push([...args]);
        return spawn(command, args, options);
      }) as never,
    });
    const originalVersion = process.env.FAKE_CODEX_VERSION;
    process.env.FAKE_CODEX_VERSION = 'codex-cli 0.148.0';
    try {
      const prepared = await adapter.prepare({
        offer: { instruction: 'publish one message', policy: { mode: 'auto' } },
        policy: { mode: 'auto' },
        descriptor: adapter.descriptor,
        requiredToolsetIds: [],
        mcpServers: { byokagentmessage: { command: '/opt/byok-agent-message-mcp' } },
      });
      expect(prepared).toMatchObject({
        kind: 'reject', retryable: false,
        reason: expect.stringContaining('lacks the required per-MCP-tool approval contract'),
      });
      expect(captured).toHaveLength(0);
    } finally {
      if (originalVersion === undefined) delete process.env.FAKE_CODEX_VERSION;
      else process.env.FAKE_CODEX_VERSION = originalVersion;
    }
  });
});
