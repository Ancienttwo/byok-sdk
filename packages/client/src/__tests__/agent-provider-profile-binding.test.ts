import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createEnvelope, type ProviderProfileBinding } from '@byok-sdk/protocol';

import { PiAdapter } from '../adapters/pi/pi-adapter';
import { createDaemonWithAdapters } from '../daemon/create-daemon';
import type { RuntimeAdapterPrepareInput } from '../types';
import { TestServer } from './fixtures/test-server';

const PI_FIXTURE_PATH = fileURLToPath(new URL('./fixtures/fake-pi.mjs', import.meta.url));

const binding: ProviderProfileBinding = {
  profileRef: 'openrouter-primary',
  profileRevision: '1787702400000',
  profileHash: `sha256:${'a'.repeat(64)}`,
  modelId: 'anthropic/claude-sonnet-4',
  requiredCapabilities: ['image-input'],
};

function prepareInput(): RuntimeAdapterPrepareInput {
  return {
    offer: {
      instruction: 'inspect image',
      policy: { mode: 'auto' },
      dispatchSelection: {
        lane: 'byok-profile',
        runtimeId: 'pi',
        providerProfile: binding,
      },
    },
    policy: { mode: 'auto' },
    descriptor: new PiAdapter().descriptor,
    requiredToolsetIds: [],
  };
}

describe('Agent provider profile binding admission', () => {
  it('validates the exact non-secret binding before returning a prepared operation', async () => {
    const validateProviderProfileBinding = vi.fn(async () => undefined);
    const adapter = new PiAdapter({
      resolveBin: () => ({ command: '/tmp/pi', source: 'env' }),
      resolveExtensions: () => ({
        webAccess: '/tmp/web-access.mjs',
        mcpAdapter: '/tmp/mcp-adapter.mjs',
        subagentsPolicy: '/tmp/subagents-policy.mjs',
        subagents: '/tmp/subagents.mjs',
        todo: '/tmp/todo.mjs',
      }),
      byokLauncher: {
        command: '/tmp/byok-pi-provider-launcher',
        profileDbPath: '/tmp/providers.sqlite',
        sessionDir: '/tmp/pi-sessions',
      },
      validateProviderProfileBinding,
    } as never);

    await expect(adapter.prepare(prepareInput())).resolves.toMatchObject({ kind: 'prepared' });
    expect(validateProviderProfileBinding).toHaveBeenCalledWith(
      expect.objectContaining(binding),
      expect.objectContaining({ profileDbPath: '/tmp/providers.sqlite' }),
    );
  });

  it('declines stale local profile authority before preparation completes', async () => {
    const adapter = new PiAdapter({
      resolveBin: () => ({ command: '/tmp/pi', source: 'env' }),
      resolveExtensions: () => ({
        webAccess: '/tmp/web-access.mjs',
        mcpAdapter: '/tmp/mcp-adapter.mjs',
        subagentsPolicy: '/tmp/subagents-policy.mjs',
        subagents: '/tmp/subagents.mjs',
        todo: '/tmp/todo.mjs',
      }),
      byokLauncher: {
        command: '/tmp/byok-pi-provider-launcher',
        profileDbPath: '/tmp/providers.sqlite',
        sessionDir: '/tmp/pi-sessions',
      },
      validateProviderProfileBinding: async () => {
        throw new Error('provider profile revision mismatch');
      },
    } as never);

    await expect(adapter.prepare(prepareInput())).resolves.toEqual({
      kind: 'reject',
      reason: 'provider profile admission failed: provider profile revision mismatch',
      retryable: false,
    });
  });

  it('declines a stale binding before claim, runtime spawn, or workspace creation', async () => {
    const server = await TestServer.start();
    const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-profile-binding-workspace-'));
    const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-profile-binding-store-'));
    const spawnFn = vi.fn(() => {
      throw new Error('runtime spawn is forbidden before provider admission');
    });
    const adapter = new PiAdapter({
      resolveBin: () => ({ command: PI_FIXTURE_PATH, source: 'env' }),
      resolveExtensions: () => ({
        webAccess: '/tmp/web-access.mjs',
        mcpAdapter: '/tmp/mcp-adapter.mjs',
        subagentsPolicy: '/tmp/subagents-policy.mjs',
        subagents: '/tmp/subagents.mjs',
        todo: '/tmp/todo.mjs',
      }),
      spawnFn: spawnFn as never,
      byokLauncher: {
        command: '/tmp/byok-pi-provider-launcher',
        profileDbPath: '/tmp/providers.sqlite',
        sessionDir: '/tmp/pi-sessions',
      },
      validateProviderProfileBinding: async () => {
        throw new Error('provider profile hash mismatch');
      },
    });
    const daemon = createDaemonWithAdapters({
      localAgentRelease: { version: '0.0.0-test' },
      productName: 'Provider binding test',
      productId: 'provider-binding-test',
      serverUrl: server.url,
      workspaceRoot,
      storeDir,
    }, [adapter]);
    try {
      await daemon.pair('pairing-code');
      await daemon.start();
      const taskId = 'task-stale-provider-profile';
      server.send(createEnvelope('task.offer', {
        instruction: 'inspect image',
        policy: { mode: 'auto' },
        dispatchSelection: {
          lane: 'byok-profile',
          runtimeId: 'pi',
          providerProfile: binding,
        },
      }, { taskId, seq: server.nextSeq() }));

      const decline = await server.waitFor((envelope) => envelope.type === 'task.decline' && envelope.task_id === taskId);
      expect(decline.type === 'task.decline' && decline.payload.reason).toMatch(/hash mismatch/);
      expect(server.received.some((envelope) => envelope.type === 'task.claim' && envelope.task_id === taskId)).toBe(false);
      expect(spawnFn).not.toHaveBeenCalled();
      await expect(fs.stat(path.join(workspaceRoot, taskId))).rejects.toThrow();
    } finally {
      await daemon.stop();
      await server.close();
    }
  });
});
