import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ registered: [] as unknown[] }));

vi.mock('pi-subagents', () => ({ default: (() => undefined) }));
vi.mock('pi-subagents/required-child-extensions', () => ({
  registerRequiredChildExtensions: (input: unknown) => {
    state.registered.push(input);
    return { dispose: () => undefined };
  },
}));

import { loadPiSubagentsExtensions } from '../adapters/pi/subagents';
import type { ToolAuthorizationIpcConfig } from '../tool-authorization-ipc';

const gate: ToolAuthorizationIpcConfig = {
  url: 'http://127.0.0.1:9/authorize-tool', token: 'a'.repeat(64), timeoutMs: 100,
};

/** Run the SDK registration extension and return the exact input handed to pi-subagents. */
async function registeredInput(fileScopePath?: string): Promise<{ extensions: readonly { id: string; path: string }[]; requireForAllRunners: boolean }> {
  state.registered.length = 0;
  const factories = await loadPiSubagentsExtensions(gate, '/dist/bin/pi-subagent-gate.js', fileScopePath);
  const register = factories[1]!;
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
});
