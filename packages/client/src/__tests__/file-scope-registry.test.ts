import { describe, expect, it } from 'vitest';
import { assertPiFileScopeRegistry, type PiToolRegistryView } from '../adapters/pi/file-scope-registry';

const expectation = { required: ['read', 'write', 'edit', 'find', 'grep', 'ls'], forbidden: [] };

function view(
  tools: readonly { name: string; source?: string }[],
  active: readonly string[] = tools.map((tool) => tool.name),
): PiToolRegistryView {
  return {
    getAllTools: () => tools.map((tool) => ({
      name: tool.name,
      ...(tool.source === undefined ? {} : { sourceInfo: { path: tool.source } }),
    })),
    getActiveToolNames: () => active,
  };
}

describe('scoped Pi tool loadout assertion (#1061 slice 3)', () => {
  it('accepts the six SDK scoped tools and keeps bash native', () => {
    expect(() => assertPiFileScopeRegistry(view([
      { name: 'read', source: '/extension/file-scope-extension.js' },
      { name: 'write', source: '/extension/file-scope-extension.js' },
      { name: 'edit', source: '/extension/file-scope-extension.js' },
      { name: 'find', source: '/extension/file-scope-extension.js' },
      { name: 'grep', source: '/extension/file-scope-extension.js' },
      { name: 'ls', source: '/extension/file-scope-extension.js' },
      { name: 'bash', source: 'builtin:bash' },
    ]), expectation)).not.toThrow();
  });

  it('refuses a builtin read that was not shadowed', () => {
    expect(() => assertPiFileScopeRegistry(view([
      { name: 'read', source: 'builtin:read' },
      { name: 'write', source: '/extension/file-scope-extension.js' },
      { name: 'edit', source: '/extension/file-scope-extension.js' },
      { name: 'find', source: '/extension/file-scope-extension.js' },
      { name: 'grep', source: '/extension/file-scope-extension.js' },
      { name: 'ls', source: '/extension/file-scope-extension.js' },
    ]), expectation)).toThrow(/file_scope_registry_drift: read is still the Pi built-in/);
  });

  it('refuses a builtin find/grep/ls that was not shadowed', () => {
    for (const name of ['find', 'grep', 'ls']) {
      expect(() => assertPiFileScopeRegistry(view([
        { name: 'read', source: '/ext' }, { name: 'write', source: '/ext' }, { name: 'edit', source: '/ext' },
        { name: 'find', source: '/ext' }, { name: 'grep', source: '/ext' }, { name: 'ls', source: '/ext' },
      ].map((tool) => tool.name === name ? { ...tool, source: 'builtin:' + name } : tool)), expectation))
        .toThrow(new RegExp('file_scope_registry_drift: ' + name + ' is still the Pi built-in'));
    }
  });

  it('still refuses a separately named forbidden native tool', () => {
    const forbidden = { required: ['read', 'write', 'edit', 'find', 'grep', 'ls'], forbidden: ['powershell'] };
    expect(() => assertPiFileScopeRegistry(view([
      { name: 'read', source: '/ext' }, { name: 'write', source: '/ext' }, { name: 'edit', source: '/ext' },
      { name: 'find', source: '/ext' }, { name: 'grep', source: '/ext' }, { name: 'ls', source: '/ext' },
      { name: 'powershell', source: 'builtin:powershell' },
    ]), forbidden)).toThrow(/native powershell must not be registered/);
  });

  it('refuses a missing or inactive scoped tool', () => {
    expect(() => assertPiFileScopeRegistry(view([
      { name: 'write', source: '/ext' }, { name: 'edit', source: '/ext' },
      { name: 'find', source: '/ext' }, { name: 'grep', source: '/ext' }, { name: 'ls', source: '/ext' },
    ]), expectation)).toThrow(/scoped read tool was not registered/);
    expect(() => assertPiFileScopeRegistry(view([
      { name: 'read', source: '/ext' }, { name: 'write', source: '/ext' }, { name: 'edit', source: '/ext' },
      { name: 'find', source: '/ext' }, { name: 'grep', source: '/ext' }, { name: 'ls', source: '/ext' },
    ], ['read', 'write', 'edit', 'find', 'grep']), expectation)).toThrow(/scoped ls tool is not active/);
  });
});
