import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ registered: [] as unknown[] }));

vi.mock('pi-subagents', () => ({ default: (() => undefined) }));
vi.mock('pi-subagents/required-child-extensions', () => ({
  registerRequiredChildExtensions: (input: unknown) => {
    state.registered.push(input);
    return { dispose: () => undefined };
  },
}));

import { loadPiSubagentsAsset, loadPiSubagentsExtensions } from '../adapters/pi/subagents';
import type { ToolAuthorizationIpcConfig } from '../tool-authorization-ipc';

const gate: ToolAuthorizationIpcConfig = {
  url: 'http://127.0.0.1:9/authorize-tool', token: 'a'.repeat(64), timeoutMs: 100,
};

/** Run the SDK registration extension and return the exact input handed to pi-subagents. */
async function registeredInput(fileScopePath?: string, factories?: readonly unknown[]): Promise<{ extensions: readonly { id: string; path: string }[]; requireForAllRunners: boolean }> {
  state.registered.length = 0;
  const register = (factories ?? await loadPiSubagentsExtensions(gate, '/dist/bin/pi-subagent-gate.js', fileScopePath)).at(-1) as (pi: never) => void;
  let start: ((event: unknown, context: { sessionManager: { getSessionId(): string } }) => unknown) | undefined;
  register({
    on: (event: string, handler: (event: unknown, context: { sessionManager: { getSessionId(): string } }) => unknown) => {
      if (event === 'session_start') start = handler;
    },
  } as never);
  await start!({}, { sessionManager: { getSessionId: () => 'session-1' } });
  return state.registered[0] as { extensions: readonly { id: string; path: string }[]; requireForAllRunners: boolean };
}

describe('native Pi subagent required-extension order (#1061 D11)', () => {
  it('registers the file-scope extension before the tool authorization gate', async () => {
    const input = await registeredInput('/dist/bin/pi-subagent-file-scope.js');
    expect(input.requireForAllRunners).toBe(true);
    expect(input.extensions).toEqual([
      { id: 'byok-file-scope', path: '/dist/bin/pi-subagent-file-scope.js' },
      { id: 'byok-tool-authorization', path: '/dist/bin/pi-subagent-gate.js' },
    ]);
    // The order is what makes the scope precheck run before the auth hook.
    expect(input.extensions[0]!.id).toBe('byok-file-scope');
    expect(input.extensions[input.extensions.length - 1]!.id).toBe('byok-tool-authorization');
  });

  it('requires only the gate when the parent has no file scope', async () => {
    const input = await registeredInput();
    expect(input.extensions).toEqual([{ id: 'byok-tool-authorization', path: '/dist/bin/pi-subagent-gate.js' }]);
  });

  // #1589: a single-file product's copy in its Pi asset root; its registration module records into the same state.
  it('requires the asset root child extensions, gate last, from the exact pinned copy only', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'byok-subagent-asset-')));
    try {
      const dir = path.join(root, 'pi-subagents');
      await mkdir(path.join(dir, 'bundle'), { recursive: true });
      const manifest = (version: string) => JSON.stringify({ name: 'pi-subagents', version, pi: { extensions: ['./bundle/index.js'] },
        exports: { './required-child-extensions': { default: './bundle/required-child-extensions.mjs' } } });
      await writeFile(path.join(dir, 'bundle', 'required-child-extensions.mjs'),
        'export const registerRequiredChildExtensions = input => { globalThis.__byokRegistered.push(input); return { dispose() {} }; };');
      (globalThis as { __byokRegistered?: unknown[] }).__byokRegistered = state.registered;
      await writeFile(path.join(dir, 'package.json'), manifest('0.87.0'));
      const asset = await loadPiSubagentsAsset(root, gate, true);
      expect(asset.extensionPath).toBe(path.join(dir, 'bundle', 'index.js'));
      const input = await registeredInput(undefined, asset.factories);
      expect(input.requireForAllRunners).toBe(true);
      expect(input.extensions).toEqual([
        { id: 'byok-file-scope', path: path.join(root, 'pi-subagent-extensions', 'pi-subagent-file-scope.js') },
        { id: 'byok-tool-authorization', path: path.join(root, 'pi-subagent-extensions', 'pi-subagent-gate.js') },
      ]);
      await writeFile(path.join(dir, 'package.json'), manifest('0.86.0'));
      await expect(loadPiSubagentsAsset(root, gate, true)).rejects.toThrow(/pi_bundled_assets_unavailable: .*pi-subagents@0\.86\.0, not pi-subagents@0\.87\.0/u);
      await expect(loadPiSubagentsAsset(path.join(root, 'absent'), gate, false)).rejects.toThrow(/pi_bundled_assets_unavailable: the Pi asset root has no pi-subagents package/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
