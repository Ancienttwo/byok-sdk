import { describe, expect, it } from 'vitest';
import { McpToolsetRegistry, McpToolsetRevisionConflictError } from '../daemon/toolset-registry';
import { RESERVED_MCP_SERVER_NAMES } from '../sdk-reserved-mcp';
import type { McpToolsetConfig } from '../types';

const definition = (approveTools?: readonly string[]) => ({
  host: { mcpServers: { host: { command: '/opt/host-mcp', ...(approveTools === undefined ? {} : { approveTools }) } } },
});

describe('Host MCP toolset exposure', () => {
  const omitted = definition();
  const direct = { host: { ...omitted.host, exposure: 'direct' as const } };
  const search = { host: { ...omitted.host, exposure: 'search' as const } };
  const observation = { state: 'ready', observedAt: '2026-10-28T00:00:00.000Z' } as const;

  it('preserves the pre-exposure digests for omitted and explicit direct', () => {
    const legacyRegistry = 'sha256:55cdc00045a53e0e39649389abc2e7d5e0dc2041ebf52b2dbec32d7ff27adb6e';
    const legacyDefinition = 'sha256:8bfeefcefd64c39779c2f125bf29c582ad929920f5178768226b6b5e1a1590ba';
    const registry = new McpToolsetRegistry(omitted);
    expect(registry.status()).toMatchObject({ revision: legacyRegistry, toolsets: [{ definitionRevision: legacyDefinition }] });
    expect(new McpToolsetRegistry(direct).status()).toEqual(registry.status());
    registry.report('host', legacyDefinition, observation);
    expect(registry.reload(direct, legacyRegistry)).toMatchObject({ changed: false, toolsets: [{ observation }] });
  });

  it('updates both revisions and clears observations on each exposure switch', () => {
    const registry = new McpToolsetRegistry(direct);
    const before = registry.status();
    registry.report('host', before.toolsets[0]!.definitionRevision, observation);
    const enabled = registry.reload(search, before.revision);
    expect(enabled.changed).toBe(true);
    expect(enabled.revision).not.toBe(before.revision);
    expect(enabled.toolsets[0]!.definitionRevision).not.toBe(before.toolsets[0]!.definitionRevision);
    expect(enabled.toolsets[0]!.observation).toBeUndefined();
    const frozen = registry.snapshot().toolsets.get('host')!;
    expect(frozen.exposure).toBe('search');
    expect(Object.isFrozen(frozen)).toBe(true);

    registry.report('host', enabled.toolsets[0]!.definitionRevision, observation);
    expect(() => registry.reload(direct, before.revision)).toThrow(McpToolsetRevisionConflictError);
    expect(registry.status().toolsets[0]!.observation).toEqual(observation);
    expect(registry.reload(direct, enabled.revision)).toMatchObject({ changed: true, ...before });
    expect(registry.status()).toEqual(before);
    expect(frozen.exposure).toBe('search');
  });

  it('rejects an invalid exposure atomically at the registry boundary', () => {
    const registry = new McpToolsetRegistry(search);
    registry.report('host', registry.status().toolsets[0]!.definitionRevision, observation);
    const before = registry.status();
    const invalid = { host: { ...search.host, exposure: 'auto' } } as unknown as Record<string, McpToolsetConfig>;
    expect(() => registry.reload(invalid, before.revision)).toThrow(/mcpToolsets\.host\.exposure/);
    expect(registry.status()).toEqual(before);
    expect(registry.snapshot().toolsets.get('host')!.exposure).toBe('search');
  });
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
