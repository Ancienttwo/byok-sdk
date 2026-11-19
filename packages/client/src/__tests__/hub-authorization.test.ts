import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createCodexMcpHubCallPolicy } from '../adapters/codex/hub-tool-grants';
import { bindMcpHubAuthorization } from '../mcp/hub-authorization';
import { publishMcpHubCatalog, type McpHubCatalogBinding } from '../mcp/hub/catalog';
import { createAutoToolAuthorizationGate, type ToolCall } from '../tool-authorization';
import { observationOf } from './fixtures/mcp-observation';

const outer = 'mcp__byoktools__call_tool';
const hubIdentity = { server: 'byoktools', tool: 'call_tool' };
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture(options: Partial<Parameters<typeof createAutoToolAuthorizationGate>[0]> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'byok-hub-auth-'));
  dirs.push(home);
  const cwd = join(home, 'work');
  await mkdir(cwd);
  let active = true;
  const servers = observationOf({ alpha: ['echo'], beta: ['echo'] });
  const catalog: McpHubCatalogBinding = {
    catalogPath: join(home, 'catalog.json'), attemptId: 'attempt-1', launchCwd: cwd, mcpEnv: {},
    mcpServers: { alpha: { command: 'fixture' }, beta: { command: 'fixture' } },
  };
  const requestAuthorization = vi.fn(async () => ({ approved: false }));
  const onDecision = vi.fn();
  const gate = createAutoToolAuthorizationGate({ workspace: cwd, home, timeoutMs: 2_000, requestAuthorization, onDecision,
    mcpIdentities: new Map([[outer, hubIdentity], ['mcp__beta__echo', { server: 'beta', tool: 'echo' }]]), ...options,
  });
  bindMcpHubAuthorization(gate, { catalog, isActive: () => active });
  const publish = (binding = catalog) => publishMcpHubCatalog(binding, Object.values(servers), new AbortController().signal);
  const call = (server = 'alpha', args = {}, tool = 'echo'): ToolCall => ({
    toolCallId: server, toolName: outer, input: { server, tool, arguments: args }, cwd: home,
  });
  return { catalog, call, gate, publish, requestAuthorization, onDecision, revoke: () => { active = false; } };
}

it('routes concurrent inner calls to exact selectors, approvals and audit records', async () => {
  const f = await fixture({ rules: { alwaysAsk: [
    { id: 'alpha-echo', match: { toolName: 'mcp__alpha__echo', mcpServer: 'alpha', mcpTool: 'echo' } },
  ] } });
  await f.publish();
  f.requestAuthorization.mockResolvedValueOnce({ approved: true });
  const allowed = await Promise.all([f.gate.authorize(f.call()), f.gate.authorize(f.call('beta'))]);
  expect(allowed.map(verdict => verdict.decision)).toEqual(['allow', 'allow']);
  expect(await f.gate.authorize(f.call())).toMatchObject({ decision: 'deny', code: 'tool_authorization_denied' });
  expect(f.onDecision).toHaveBeenCalledWith(expect.objectContaining({ call: expect.objectContaining({
    toolName: 'mcp__alpha__echo', mcp: { server: 'alpha', tool: 'echo' }, input: {},
  }) }));
  expect(f.requestAuthorization).toHaveBeenCalledTimes(2);
});

it('classifies the inner command and relative protected path using the real hub cwd', async () => {
  const f = await fixture({ rules: { allowWithoutAsking: [{ id: 'allow-echo', match: { mcpTool: 'echo' } }] } });
  await f.publish();
  expect(await f.gate.authorize(f.call('alpha', { command: 'sudo fixture && echo ok', path: '../.ssh/fixture' })))
    .toMatchObject({ decision: 'deny', authorization: { source: 'floor' } });
  expect(f.onDecision).toHaveBeenCalledWith(expect.objectContaining({
    call: expect.objectContaining({ cwd: f.catalog.launchCwd }),
    risk: expect.objectContaining({ reasons: ['privilege-escalation', 'sensitive-path'] }),
  }));
});

it.each(['unpublished', 'unknown', 'malformed', 'wrong-attempt', 'revoked'] as const)(
  'denies %s hub calls before risk classification', async state => {
    const f = await fixture();
    if (state !== 'unpublished') await f.publish(state === 'wrong-attempt' ? { ...f.catalog, attemptId: 'old-attempt' } : f.catalog);
    if (state === 'revoked') f.revoke();
    const call = state === 'unknown' ? f.call('alpha', {}, 'Echo') : f.call();
    const input = state === 'malformed' ? { ...call.input, arguments: ['not an object'] } : call.input;
    expect(await f.gate.authorize({ ...call, input })).toMatchObject({ decision: 'deny', code: 'tool_authorization_unavailable' });
    expect(f.requestAuthorization).not.toHaveBeenCalled();
    expect(f.onDecision.mock.calls[0]?.[0].risk).toBeUndefined();
  },
);

it('rechecks the Attempt after a pending approval', async () => {
  const f = await fixture({ rules: { alwaysAsk: [{ id: 'ask', match: { mcpServer: 'alpha' } }] } });
  await f.publish();
  f.requestAuthorization.mockImplementationOnce(async () => { f.revoke(); return { approved: true }; });
  expect(await f.gate.authorize(f.call())).toMatchObject({ decision: 'deny', code: 'tool_authorization_unavailable' });
});

it('keeps direct and built-in calls on their native path and rejects a forged outer label', async () => {
  const f = await fixture();
  await f.publish();
  const resolve = vi.fn(async () => undefined);
  const forged = { ...f.call(), mcp: hubIdentity };
  expect(await f.gate.authorize(forged, resolve)).toMatchObject({ decision: 'deny', code: 'tool_authorization_unavailable' });
  expect(resolve).toHaveBeenCalledOnce();
  expect(await f.gate.authorize({ ...forged, toolName: 'call_tool', input: {} }, resolve)).toMatchObject({ decision: 'allow' });
  expect(resolve).toHaveBeenCalledOnce();
  expect(await f.gate.authorize({ ...forged, toolName: 'mcp__beta__echo', input: { server: 'alpha', tool: 'echo' } }))
    .toMatchObject({ decision: 'allow' });
  expect(f.onDecision.mock.lastCall?.[0].call).toMatchObject({ mcp: { server: 'beta', tool: 'echo' }, input: { server: 'alpha', tool: 'echo' } });
});

it('requires a frozen Codex grant and catalog hit on the same pair', async () => {
  const f = await fixture();
  const grants = { alpha: ['echo', 'missing'], beta: ['Echo', '*'] };
  const policy = createCodexMcpHubCallPolicy(f.catalog, grants);
  const signal = new AbortController().signal;
  const call = { server: 'alpha', tool: 'echo', arguments: {} };
  expect(await policy(call, signal)).toBe(false);
  await f.publish();
  grants.alpha.splice(0);
  grants.beta.push('echo');
  expect(await Promise.all([
    policy(call, signal), policy({ ...call, server: 'beta' }, signal), policy({ ...call, tool: 'missing' }, signal),
    policy(call, AbortSignal.abort()),
  ])).toEqual([true, false, false, false]);
});
