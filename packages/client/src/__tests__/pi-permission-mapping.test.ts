import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { createPiMcpTools } from '../adapters/pi/mcp-tools';
import { projectMcpTools } from '../mcp/projection';
import { observationOf } from './fixtures/mcp-observation';
import { describe, expect, it } from 'vitest';
import type { PermissionPolicy } from '@byok-sdk/protocol';
import { mapPermissionPolicyToPiArgs, resolvePiNativeToolSelection } from '../adapters/pi/permission-mapping';

describe('mapPermissionPolicyToPiArgs', () => {
  it('auto with no restrictions maps to no args', () => {
    const result = mapPermissionPolicyToPiArgs({ mode: 'auto' });
    expect(result).toEqual({ ok: true, args: [] });
  });

  it('auto with allowTools maps to --tools', () => {
    const result = mapPermissionPolicyToPiArgs({ mode: 'auto', allowTools: ['bash', 'edit'] });
    expect(result.ok).toBe(true);
    expect(result.args).toEqual(['--tools', 'bash,edit']);
  });

  it('readonly with no allowTools maps to the default readonly tool set', () => {
    const result = mapPermissionPolicyToPiArgs({ mode: 'readonly' });
    expect(result.ok).toBe(true);
    expect(result.args).toEqual(['--tools', 'read,grep,find,ls,subagent,todo']);
  });

  it('readonly intersects a caller-provided allowTools with the readonly set', () => {
    const result = mapPermissionPolicyToPiArgs({ mode: 'readonly', allowTools: ['read', 'bash'] });
    expect(result.ok).toBe(true);
    expect(result.args).toEqual(['--tools', 'read']);
  });

  it('readonly falls back to --no-tools when allowTools has no overlap with the readonly set (never silently widens)', () => {
    const result = mapPermissionPolicyToPiArgs({ mode: 'readonly', allowTools: ['bash', 'write'] });
    expect(result.ok).toBe(true);
    expect(result.args).toEqual(['--no-tools']);
  });

  it('denyTools maps to pi 0.85.1\'s native --exclude-tools flag', () => {
    const result = mapPermissionPolicyToPiArgs({ mode: 'auto', denyTools: ['bash'] });
    expect(result.ok).toBe(true);
    expect(result.args).toEqual(['--exclude-tools', 'bash']);
  });

  it('passes explicit allowTools and denyTools as separate native constraints', () => {
    const result = mapPermissionPolicyToPiArgs({ mode: 'auto', allowTools: ['bash', 'edit'], denyTools: ['edit'] });
    expect(result.ok).toBe(true);
    expect(result.args).toEqual(['--tools', 'bash,edit', '--exclude-tools', 'edit']);
  });

  it('lets pi apply a denylist that removes every explicitly allowed tool', () => {
    const result = mapPermissionPolicyToPiArgs({
      mode: 'auto',
      allowTools: ['bash'],
      denyTools: ['bash'],
    });
    expect(result.ok).toBe(true);
    expect(result.args).toEqual(['--tools', 'bash', '--exclude-tools', 'bash']);
  });

  it('readonly constrains the allowlist before adding the native denylist', () => {
    const result = mapPermissionPolicyToPiArgs({ mode: 'readonly', denyTools: ['read'] });
    expect(result.ok).toBe(true);
    expect(result.args).toEqual(['--tools', 'read,grep,find,ls,subagent,todo', '--exclude-tools', 'read']);
  });

  it('an empty denyTools array behaves exactly like no denyTools at all', () => {
    expect(mapPermissionPolicyToPiArgs({ mode: 'auto', denyTools: [] })).toEqual({ ok: true, args: [] });
  });

  it.each(['confirm', 'plan'] as const)('fails closed on mode "%s" (no built-in pi equivalent)', (mode) => {
    const policy: PermissionPolicy = { mode };
    const result = mapPermissionPolicyToPiArgs(policy);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(new RegExp(mode));
  });

  it('fails closed on network:false (pi has no network sandbox)', () => {
    const result = mapPermissionPolicyToPiArgs({ mode: 'auto', network: false });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/network/i);
  });

  it('proceeds when network is true or unset', () => {
    expect(mapPermissionPolicyToPiArgs({ mode: 'auto', network: true }).ok).toBe(true);
    expect(mapPermissionPolicyToPiArgs({ mode: 'auto' }).ok).toBe(true);
  });
});


it('auto with an explicit empty allowlist disables native tools in both lanes', () => {
  expect(mapPermissionPolicyToPiArgs({ mode: 'auto', allowTools: [] })).toEqual({ ok: true, args: ['--no-tools'] });
  expect(resolvePiNativeToolSelection({ mode: 'auto', allowTools: [] })).toEqual({ ok: true, names: [] });
  expect(resolvePiNativeToolSelection({ mode: 'auto' }).ok).toBe(false);
});


it('auto+[] keeps observed MCP and reserved grants while denying every native default', () => {
  expect(mapPermissionPolicyToPiArgs(
    { mode: 'auto', allowTools: [] },
    [{ server: 'byokagentmessage', tools: ['send_agent_message'] }],
    [{ server: 'team', tools: ['echo'] }],
  )).toEqual({ ok: true, args: ['--tools', 'send_agent_message,mcp__team__echo'] });
});


it('the frozen fork activates observed MCP tools and no native tools for the fresh auto+[] projection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'byok-auto-zero-native-'));
  try {
    const mapped = mapPermissionPolicyToPiArgs({ mode: 'auto', allowTools: [] }, [], [{ server: 'team', tools: ['echo'] }]);
    expect(mapped).toEqual({ ok: true, args: ['--tools', 'mcp__team__echo'] });
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager, noExtensions: true, noSkills: true });
    const customTools = createPiMcpTools(projectMcpTools(observationOf({ team: ['echo'] })), {
      call: async () => { throw new Error('no tool execution in registry probe'); },
    }, 'qualified');
    const { session } = await createAgentSession({
      cwd: root, agentDir: root, settingsManager, resourceLoader: loader,
      sessionManager: SessionManager.inMemory(root),
      tools: mapped.args[1]!.split(','),
      // Pi's type expects TypeBox; the shared projection retains the observed JSON Schema.
      customTools: [...customTools] as unknown as ToolDefinition[],
    });
    try {
      expect(session.getActiveToolNames()).toEqual(['mcp__team__echo']);
    } finally { await session.dispose(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
