import { describe, expect, it } from 'vitest';
import { withCodexUserContextExcluded, verifyCodexUserContextExcluded, type CodexAppServerRequest } from '../adapters/codex/agent-user-context';
import { isRuntimeExecutionFailure } from '../runtime-failure';

// Shapes as Codex 0.160.0 and 0.164.0 answered them in a synthetic CODEX_HOME:
// a user stdio server, a dotted name and a trusted project-layer server.
const EFFECTIVE = {
  config: {
    model: 'gpt-probe-model',
    sandbox_mode: 'read-only',
    mcp_servers: {
      probe_project: { command: '/usr/bin/true', args: [], environment_id: 'local', enabled: true, tool_timeout_sec: null },
      probe_user: { command: '/usr/bin/true', args: [], environment_id: 'local', enabled: true, tool_timeout_sec: null },
      'probe.dotted': { command: '/usr/bin/true', args: [], environment_id: 'local', enabled: true, tool_timeout_sec: null },
    },
    plugins: { 'probe-plugin@probe-market': { enabled: true } },
  },
  origins: {},
};
const TASK = { command: '/sdk/bin/byok-agent-memory-mcp', args: [], enabled: true };
const OPEN = { cwd: '/home/agent', approvalPolicy: 'never', config: { model_reasoning_effort: 'high', mcp_servers: { byokagentmemory: TASK } } };

async function refusal(work: () => unknown): Promise<string> {
  try {
    await work();
  } catch (error) {
    expect(isRuntimeExecutionFailure(error)).toBe(true);
    if (!isRuntimeExecutionFailure(error)) throw error;
    expect([error.phase, error.category, error.retry, error.failure.class]).toEqual(['start', 'authority', 'non-retryable', 'unknown']);
    return error.message;
  }
  throw new Error('expected a refusal');
}

describe('withCodexUserContextExcluded', () => {
  it('disables every configured server outside the task and turns off apps and plugins', () => {
    expect(withCodexUserContextExcluded(OPEN, EFFECTIVE, ['byokagentmemory'])).toEqual({
      cwd: '/home/agent',
      approvalPolicy: 'never',
      config: {
        model_reasoning_effort: 'high',
        mcp_servers: {
          probe_project: { enabled: false },
          probe_user: { enabled: false },
          'probe.dotted': { enabled: false },
          byokagentmemory: TASK,
        },
        features: { apps: false, plugins: false },
      },
    });
  });

  it('adds the features to an open with no config and no configured servers', () => {
    expect(withCodexUserContextExcluded({ threadId: 't' }, { config: {} }, [])).toEqual({
      threadId: 't',
      config: { mcp_servers: {}, features: { apps: false, plugins: false } },
    });
  });

  it('refuses a user server that shares a task server name', async () => {
    const effective = { config: { mcp_servers: { byokagentmemory: { command: 'x', env: { NODE_OPTIONS: '--require /x' } }, zeta: {}, alpha: {} } } };
    expect(await refusal(() => withCodexUserContextExcluded(OPEN, effective, ['zeta', 'byokagentmemory', 'alpha'])))
      .toBe('codex Agent user-context exclusion refused: user MCP servers share a name with task servers: alpha, byokagentmemory, zeta');
  });

  it('refuses a configuration it cannot read', async () => {
    for (const effective of [{}, { config: null }, { config: [] }, { config: { mcp_servers: [] } }, { config: { mcp_servers: 'x' } }]) {
      expect(await refusal(() => withCodexUserContextExcluded(OPEN, effective, [])))
        .toBe('codex Agent user-context exclusion refused: config/read returned no readable configuration');
    }
  });
});

describe('verifyCodexUserContextExcluded', () => {
  const status = (name: string, runtimeStatus: string | null, pluginId: string | null = null) => ({
    name, runtimeStatus, pluginId, httpOrigin: null, serverInfo: null, tools: {}, toolsError: null, resources: [], resourceTemplates: [], authStatus: 'unsupported',
  });
  const pages = (...replies: Record<string, unknown>[]) => {
    const calls: Record<string, unknown>[] = [];
    const request: CodexAppServerRequest = async (method, params) => {
      expect(method).toBe('mcpServerStatus/list');
      calls.push(params);
      return replies[calls.length - 1]!;
    };
    return { request, calls };
  };

  it('accepts task servers and disabled servers across pages', async () => {
    const { request, calls } = pages(
      { data: [status('probe_user', 'disabled'), status('byokagentmemory', 'connected')], nextCursor: 'c1' },
      { data: [status('probe.dotted', 'disabled'), status('host_tool', 'starting')], nextCursor: null },
    );
    await verifyCodexUserContextExcluded(request, 'thread-1', ['byokagentmemory', 'host_tool']);
    expect(calls).toEqual([
      { threadId: 'thread-1', detail: 'toolsAndAuthOnly' },
      { threadId: 'thread-1', detail: 'toolsAndAuthOnly', cursor: 'c1' },
    ]);
  });

  it('refuses every server outside the task that is not disabled, a plugin server and the connector server included', async () => {
    const { request } = pages(
      { data: [status('probe_plugin_srv', 'connected', 'probe-plugin@probe-market'), status('user_notes', 'failed')], nextCursor: 'c1' },
      { data: [status('codex_apps', null), status('probe_user', 'disabled')] },
    );
    expect(await refusal(() => verifyCodexUserContextExcluded(request, 'thread-1', ['byokagentmemory'])))
      .toBe('codex Agent thread still runs MCP servers outside the task: codex_apps, probe_plugin_srv (plugin probe-plugin@probe-market), user_notes');
  });

  it('refuses a reply it cannot read', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{}, 'mcpServerStatus/list returned no server list'],
      [{ data: [{ runtimeStatus: 'disabled' }] }, 'mcpServerStatus/list returned a server without a name'],
      [{ data: [], nextCursor: 7 }, 'mcpServerStatus/list returned an invalid cursor'],
    ];
    for (const [reply, reason] of cases) {
      expect(await refusal(() => verifyCodexUserContextExcluded(pages(reply).request, 't', []))).toBe(`codex Agent user-context exclusion refused: ${reason}`);
    }
  });

  it('refuses a cursor that never ends', async () => {
    const request: CodexAppServerRequest = async () => ({ data: [], nextCursor: 'again' });
    expect(await refusal(() => verifyCodexUserContextExcluded(request, 't', [])))
      .toBe('codex Agent user-context exclusion refused: mcpServerStatus/list did not finish paging');
  });
});
