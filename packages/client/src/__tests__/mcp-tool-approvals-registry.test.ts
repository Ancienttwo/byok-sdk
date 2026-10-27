import { describe, expect, it } from 'vitest';
import { McpToolsetRegistry } from '../daemon/toolset-registry';
import { RESERVED_MCP_SERVER_NAMES } from '../sdk-reserved-mcp';
import type { McpToolsetConfig } from '../types';

const definition = (approveTools?: readonly string[]) => ({
  host: { mcpServers: { host: { command: '/opt/host-mcp', ...(approveTools === undefined ? {} : { approveTools }) } } },
});

describe('Host MCP approval definition authority', () => {
  it('canonicalizes the exact set, freezes it and makes authorization-only reload observable', () => {
    const names = ['write', 'read'];
    const registry = new McpToolsetRegistry(definition(names));
    const before = registry.status();
    const snapshot = registry.snapshot();
    names.push('delete');
    const approved = snapshot.toolsets.get('host')!.mcpServers.host!.approveTools!;
    expect(approved).toEqual(['read', 'write']);
    expect(Object.isFrozen(approved)).toBe(true);
    expect(registry.reload(definition(['read', 'write']), before.revision).changed).toBe(false);
    registry.report('host', before.toolsets[0]!.definitionRevision, { state: 'ready', observedAt: '2026-10-28T00:00:00.000Z' });
    const changed = registry.reload(definition(['read']), before.revision);
    expect(changed.changed).toBe(true);
    expect(changed.revision).not.toBe(before.revision);
    expect(registry.status().toolsets[0]!.definitionRevision).not.toBe(before.toolsets[0]!.definitionRevision);
    expect(registry.status().toolsets[0]!.observation).toBeUndefined();
    expect(approved).toEqual(['read', 'write']);
  });

  it('treats omitted and empty lists as the same no-additional-approval definition', () => {
    const registry = new McpToolsetRegistry(definition());
    expect(registry.reload(definition([]), registry.status().revision).changed).toBe(false);
    expect(registry.snapshot().toolsets.get('host')!.mcpServers.host).not.toHaveProperty('approveTools');
  });

  it.each([['*'], ['read*'], ['mcp.read'], [''], ['__proto__'], ['constructor'], ['prototype'], ['read', 'read'], ['read', 1], ['x'.repeat(65)], [1], null, 'read'].map(approveTools => ({ approveTools })))
  ('rejects an invalid approval list atomically: %j', ({ approveTools }) => {
    const registry = new McpToolsetRegistry(definition(['read']));
    const before = registry.status();
    const invalid = { host: { mcpServers: { host: { command: '/opt/host-mcp', approveTools } } } } as unknown as Record<string, McpToolsetConfig>;
    expect(() => registry.reload(invalid, before.revision)).toThrow(/approveTools/);
    expect(registry.status()).toEqual(before);
  });

  it.each(RESERVED_MCP_SERVER_NAMES)('does not let Host configuration approve reserved server %s', server => {
    expect(() => new McpToolsetRegistry({ host: { mcpServers: {
      [server]: { command: '/opt/host-mcp', approveTools: ['submit_result'] },
    } } })).toThrow(/reserved by the daemon/);
  });

  it('rejects server-wide defaults instead of turning them into a tool grant', () => {
    expect(() => new McpToolsetRegistry({ host: { mcpServers: { host: {
      command: '/opt/host-mcp', default_tools_approval_mode: 'approve',
    } } } } as never)).toThrow(/accepts only command, args and approveTools/);
  });
});
