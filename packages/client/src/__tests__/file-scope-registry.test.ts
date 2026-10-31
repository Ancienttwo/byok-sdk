import { describe, expect, it } from 'vitest';
import { assertPiFileScopeRegistry, type PiToolRegistryView } from '../adapters/pi/file-scope-registry';

const expectation = { required: ['read', 'write', 'edit'], forbidden: ['find', 'grep', 'ls'] };

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
  it('accepts the SDK scoped tools and no native find/grep/ls', () => {
    expect(() => assertPiFileScopeRegistry(view([
      { name: 'read', source: '/extension/file-scope-extension.js' },
      { name: 'write', source: '/extension/file-scope-extension.js' },
      { name: 'edit', source: '/extension/file-scope-extension.js' },
      { name: 'bash', source: 'builtin:bash' },
    ]), expectation)).not.toThrow();
  });

  it('refuses a builtin read that was not shadowed', () => {
    expect(() => assertPiFileScopeRegistry(view([
      { name: 'read', source: 'builtin:read' },
      { name: 'write', source: '/extension/file-scope-extension.js' },
      { name: 'edit', source: '/extension/file-scope-extension.js' },
    ]), expectation)).toThrow(/file_scope_registry_drift: read is still the Pi built-in/);
  });

  it('refuses a native find/grep/ls that is still registered or active', () => {
    expect(() => assertPiFileScopeRegistry(view([
      { name: 'read', source: '/ext' }, { name: 'write', source: '/ext' }, { name: 'edit', source: '/ext' },
      { name: 'grep', source: 'builtin:grep' },
    ]), expectation)).toThrow(/native grep must not be registered/);
    expect(() => assertPiFileScopeRegistry(view([
      { name: 'read', source: '/ext' }, { name: 'write', source: '/ext' }, { name: 'edit', source: '/ext' },
    ], ['read', 'write', 'edit', 'ls']), expectation)).toThrow(/native ls must not be active/);
  });

  it('refuses a missing or inactive scoped tool', () => {
    expect(() => assertPiFileScopeRegistry(view([
      { name: 'write', source: '/ext' }, { name: 'edit', source: '/ext' },
    ]), expectation)).toThrow(/scoped read tool was not registered/);
    expect(() => assertPiFileScopeRegistry(view([
      { name: 'read', source: '/ext' }, { name: 'write', source: '/ext' }, { name: 'edit', source: '/ext' },
    ], ['read', 'write']), expectation)).toThrow(/scoped edit tool is not active/);
  });
});
