import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { grokInspectRefusal } from '../adapters/grok/agent-user-mcp-servers';

// Real `grok inspect --json` output (#935 probe): ~/.grok/config.toml, a project
// .grok/config.toml and .mcp.json, ~/.claude.json, ~/.cursor/mcp.json and a user plugin.
const probe = JSON.parse(readFileSync(new URL('./fixtures/grok-inspect-1.0.52.json', import.meta.url), 'utf8'));
const PREFIX = 'grok Agent user MCP server exclusion refused';
const json = (value: unknown) => JSON.stringify(value);

describe('grokInspectRefusal', () => {
  it('lists every source that stays on under the three variables, the plugin by name', () => {
    expect(grokInspectRefusal(json(probe.off))).toBe(`${PREFIX}: Grok still loads MCP servers outside the task: `
      + 'probe_grok_project (configToml), probe_grok_user (configToml), probe_mcpjson_project (mcpJson); enabled plugins provide MCP servers: probe-plugin');
  });

  it('accepts the probe once only the two compatibility servers remain, both disabled', () => {
    const compatOnly = {
      ...probe.off,
      mcpServers: probe.off.mcpServers.filter((server: { vendor?: string }) => server.vendor !== undefined),
      plugins: [],
    };
    expect(compatOnly.mcpServers.map((server: { name: string; disabled?: boolean }) => [server.name, server.disabled]))
      .toEqual([['probe_claude_user', true], ['probe_cursor_user', true]]);
    expect(grokInspectRefusal(json(compatOnly))).toBeUndefined();
  });

  it('refuses the compatibility servers when the variables did not reach inspect', () => {
    const compatOnly = { ...probe.default, mcpServers: probe.default.mcpServers.filter((server: { vendor?: string }) => server.vendor !== undefined), plugins: [] };
    expect(grokInspectRefusal(json(compatOnly))).toBe(`${PREFIX}: Grok still loads MCP servers outside the task: probe_claude_user (claudeJson), probe_cursor_user (mcpJson)`);
  });

  it('ignores a disabled plugin and a plugin without servers', () => {
    const plugins = [
      { name: 'off', enabled: false, provides: { skills: 0, agents: 0, hooks: false, mcpServers: 2 } },
      { name: 'skills-only', enabled: true, provides: { skills: 3, agents: 0, hooks: false, mcpServers: 0 } },
    ];
    expect(grokInspectRefusal(json({ mcpServers: [], plugins }))).toBeUndefined();
  });

  it('refuses output it cannot read', () => {
    for (const output of ['', 'not json', '[]', json({ mcpServers: [] }), json({ plugins: [] }), json({ mcpServers: [{}], plugins: [] }),
      json({ mcpServers: [], plugins: [{ name: 'p', enabled: true, provides: {} }] })]) {
      expect(grokInspectRefusal(output)).toBe(`${PREFIX}: grok inspect failed`);
    }
  });
});
