import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../adapters/codex/codex-adapter';
import { withCodexMcpToolGrants } from '../adapters/codex/reserved-mcp-tool-grants';
import type { Session } from '../types';
import { startPreparedOperation } from './fixtures/prepared-operation';
import { observationOf } from './fixtures/mcp-observation';

const FAKE_CODEX = fileURLToPath(new URL('./fixtures/fake-codex.mjs', import.meta.url));
const sessions: Session[] = [];
const dirs: string[] = [];
const approve = { approval_mode: 'approve' };
const expectedTools = {
  byokagentmessage: { send_agent_message: approve },
  byokagentmemory: { memory_recall: approve, memory_save: approve },
  byokagentteam: { post_team_message: approve, read_team_messages: approve, ack_team_messages: approve },
  byokagentresult: { submit_result: approve },
};

afterEach(async () => {
  await Promise.all(sessions.splice(0).map(session => session.close()));
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe('Codex reserved MCP tool grants (#1058)', () => {
  it.each([
    { sessionRef: undefined, interactive: false },
    { sessionRef: 'fake-thread-1', interactive: false },
    { sessionRef: undefined, interactive: true },
    { sessionRef: 'fake-thread-1', interactive: true },
  ])('projects exact Host grants without changing helper or native interaction authority: %j', async ({ sessionRef, interactive }) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-codex-host-grants-'));
    dirs.push(dir);
    const home = await fs.realpath(dir);
    const receipt = path.join(home, 'rpc.jsonl');
    const adapter = new CodexAdapter({
      resolveBin: () => ({ command: FAKE_CODEX, source: 'path' }),
      agentUserMcpServers: 'excluded',
      ...(interactive ? { nativeInteractions: { onRequest: () => {} } } : {}),
    });
    expect(adapter.descriptor.mcpToolApprovals).toBe(true);
    const session = await startPreparedOperation(adapter, {
      instruction: 'hello', ...(sessionRef === undefined ? {} : { sessionRef }),
    }, {
      workspaceDir: home, agentHome: home,
      env: { PATH: process.env.PATH, HOME: os.homedir(), FAKE_CODEX_RPC_RECEIPT: receipt,
        FAKE_CODEX_USER_CONFIG: JSON.stringify({ mcp_servers: { user: { command: 'user-mcp' } } }) },
      mcpServers: {
        host: { command: process.execPath, args: ['host.mjs'] },
        other: { command: process.execPath, args: ['other.mjs'] },
        byokagentresult: { command: process.execPath, args: ['helper.mjs'] },
      },
      mcpToolApprovals: Object.freeze({ host: Object.freeze(['submit_result']) }),
    });
    sessions.push(session);
    for await (const event of session.events) if (event.type === 'turn_end') break;
    const frames = (await fs.readFile(receipt, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const opened = frames.find(frame => frame.method === (sessionRef === undefined ? 'thread/start' : 'thread/resume')).params;
    expect(opened.approvalPolicy).toBe(interactive ? 'on-request' : 'never');
    expect(opened.config.mcp_servers.host).toEqual({ command: process.execPath, args: ['host.mjs'], enabled: true, tools: { submit_result: approve } });
    expect(opened.config.mcp_servers.other).toEqual({ command: process.execPath, args: ['other.mjs'], enabled: true });
    expect(opened.config.mcp_servers.byokagentresult.tools).toEqual(expectedTools.byokagentresult);
    expect(opened.config.mcp_servers.user).toEqual({ enabled: false });
    expect(opened.config.features).toEqual({ apps: false, plugins: false });
    expect(JSON.stringify(opened.config)).not.toContain('default_tools_approval_mode');
    expect(JSON.stringify(opened.config)).not.toContain('enabled_tools');
  });

  it('preserves an exact misspelled Host declaration without inventing a matching grant', () => {
    const params = { config: { mcp_servers: { host: { command: 'host', enabled: true } } } };
    const result = withCodexMcpToolGrants(params, ['host'], { host: ['submit_reslut'] });
    expect(result).toEqual({ config: { mcp_servers: { host: { command: 'host', enabled: true,
      tools: { submit_reslut: approve },
    } } } });
    expect(params.config.mcp_servers.host).not.toHaveProperty('tools');
  });

  it('refuses Host attempts to grant a reserved or uninjected server', () => {
    const params = { config: { mcp_servers: { byokagentresult: { command: 'helper' } } } };
    const rejectedApprovals: ReadonlyArray<Readonly<Record<string, readonly string[]>>> = [
      { byokagentresult: ['extra_tool'] },
      { missing: ['read'] },
    ];
    for (const hostApprovals of rejectedApprovals) {
      expect(() => withCodexMcpToolGrants(params, ['byokagentresult'], hostApprovals)).toThrow(/injected non-reserved server/);
    }
  });

  it.each([
    { sessionRef: undefined, excluded: false },
    { sessionRef: 'fake-thread-1', excluded: false },
    { sessionRef: undefined, excluded: true },
    { sessionRef: 'fake-thread-1', excluded: true },
  ])('grants injected helpers on start/resume and composes with user exclusion: %j', async ({ sessionRef, excluded }) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-codex-helper-grants-'));
    dirs.push(dir);
    const home = await fs.realpath(dir);
    const receipt = path.join(home, 'rpc.jsonl');
    const helpers = Object.fromEntries(Object.keys(expectedTools).map(name => [name, { command: process.execPath, args: [`${name}.mjs`] }]));
    const adapter = new CodexAdapter({
      resolveBin: () => ({ command: FAKE_CODEX, source: 'path' }),
      ...(excluded ? { agentUserMcpServers: 'excluded' as const } : {}),
    });
    const session = await startPreparedOperation(adapter, {
      instruction: 'hello', ...(sessionRef === undefined ? {} : { sessionRef }),
    }, {
      workspaceDir: home,
      agentHome: home,
      env: {
        PATH: process.env.PATH, HOME: os.homedir(),
        FAKE_CODEX_RPC_RECEIPT: receipt,
        FAKE_CODEX_USER_CONFIG: JSON.stringify({ mcp_servers: { user: { command: 'user-mcp' } } }),
      },
      mcpServers: { ...helpers, host: { command: process.execPath, args: ['host.mjs'] } },
      mcpToolsetTools: observationOf({ host: ['submit_result', 'dangerous'] }),
    });
    sessions.push(session);
    for await (const event of session.events) if (event.type === 'turn_end') break;
    const frames = (await fs.readFile(receipt, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const method = sessionRef === undefined ? 'thread/start' : 'thread/resume';
    const open = frames.find(frame => frame.method === method).params;
    expect(open.approvalPolicy).toBe('never');
    for (const [name, tools] of Object.entries(expectedTools)) {
      expect(open.config.mcp_servers[name]).toEqual({ command: process.execPath, args: [`${name}.mjs`], enabled: true, tools });
    }
    // A host tool with the same name as a helper tool gains no approval.
    expect(open.config.mcp_servers.host).toEqual({ command: process.execPath, args: ['host.mjs'], enabled: true });
    if (excluded) {
      expect(open.config.mcp_servers.user).toEqual({ enabled: false });
      expect(open.config.features).toEqual({ apps: false, plugins: false });
      expect(frames.some(frame => frame.method === 'mcpServerStatus/list')).toBe(true);
    } else {
      expect(open.config.mcp_servers).not.toHaveProperty('user');
      expect(frames.some(frame => frame.method === 'config/read')).toBe(false);
    }
  });

  it('grants only injected helper servers and preserves unrelated thread config without mutation', () => {
    const input = {
      approvalPolicy: 'on-request',
      config: {
        model_reasoning_effort: 'high',
        mcp_servers: {
          byokagentresult: { command: 'helper', args: [], tools: { submit_result: { enabled: true } } },
          host: { command: 'host', tools: { submit_result: { approval_mode: 'prompt' } } },
        },
      },
    };
    const snapshot = structuredClone(input);
    expect(withCodexMcpToolGrants(input, ['byokagentresult', 'host'])).toEqual({
      ...input,
      config: {
        ...input.config,
        mcp_servers: {
          ...input.config.mcp_servers,
          byokagentresult: { command: 'helper', args: [], tools: { submit_result: { enabled: true, approval_mode: 'approve' } } },
        },
      },
    });
    expect(input).toEqual(snapshot);
  });

  it('adds no configuration when no SDK helper was injected', () => {
    const input = { cwd: '/agent', config: { mcp_servers: { host: { command: 'host' } } } };
    expect(withCodexMcpToolGrants(input, ['host'])).toBe(input);
  });

  it('refuses an injected helper missing from the generated thread config', () => {
    expect(() => withCodexMcpToolGrants({ config: { mcp_servers: {} } }, ['byokagentresult']))
      .toThrow('codex thread config omitted injected MCP server: byokagentresult');
  });
});
