import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PiAdapter } from '../adapters/pi/pi-adapter';
import { startPreparedOperation } from './fixtures/prepared-operation';
import { parseModelProviderProfile } from '../../../keys/src/provider-profile';
import { buildPiProviderArgs } from '../../../keys/src/pi-provider-projection';
import { parsePiProviderLauncherOptions, buildPiProviderChildEnvironment } from '../../../keys/src/pi-provider-launcher-core';
import { PI_MODEL_FIXTURE } from '../../../keys/src/fixtures/pi-model-config';

describe('Pi adapter / credential launcher composition', () => {
  it.each(['env', 'package'] as const)('%s preserves actual SDK extension argv and task environment without forwarding ambient credentials', async (source) => {
    const dir = await mkdtemp(path.join(tmpdir(), 'pi-launcher-composition-'));
    const extensions = Object.fromEntries(['webAccess', 'mcpAdapter', 'subagentsPolicy', 'subagents', 'todo']
      .map(name => [name, path.join(dir, `${name}.js`)])) as any;
    let captured: { args: string[]; env: NodeJS.ProcessEnv } | undefined;
    try {
      const adapter = new PiAdapter({
        resolveBin: () => ({ command: path.join(dir, 'pi'), source }),
        resolveExtensions: () => extensions,
        byokLauncher: { command: path.join(dir, 'launcher'), profileDbPath: path.join(dir, 'profiles.db'), sessionDir: path.join(dir, 'sessions') },
        spawnFn: ((_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
          captured = { args, env: options.env }; throw new Error('capture only');
        }) as never,
      });
      await expect(startPreparedOperation(adapter, {
        instruction: 'Synthetic input', policy: { mode: 'readonly' },
        dispatchSelection: { lane: 'byok', runtimeId: 'pi', providerId: 'test-zai', modelId: 'glm-5.3-flash' },
      }, { workspaceDir: dir, policy: { mode: 'readonly' }, env: { ZAI_API_KEY: 'must-not-forward', UNRELATED: 'must-not-forward' } })).rejects.toThrow();
      expect(captured).toBeDefined();
      const profile = parseModelProviderProfile({
        adapter: 'openai_compatible', auth_mode: 'none', base_url: 'http://127.0.0.1:9191/v1',
        capabilities: [], created_at: '2026-09-10T00:00:00.000Z', updated_at: '2026-09-10T00:00:00.000Z',
        display_name: 'Synthetic', enabled: true, kind: 'model', model: 'glm-5.3-flash',
        profile_ref: 'test-zai', provider_kind: 'custom', pi_model: PI_MODEL_FIXTURE,
      });
      const options = parsePiProviderLauncherOptions(captured!.args);
      expect(options.piBin).toBe(source === 'package' ? process.execPath : path.join(dir, 'pi'));
      expect(options.piEntry).toBe(source === 'package' ? path.join(dir, 'pi') : undefined);
      expect(buildPiProviderArgs(profile, options.piArgs)).toEqual([
        ...options.piArgs, '--provider', 'byok-sdk-test-zai', '--model', 'glm-5.3-flash', '--thinking', 'low',
      ]);
      expect(options.piArgs.filter(arg => arg === '--extension')).toHaveLength(5);
      const env = buildPiProviderChildEnvironment({ ambient: captured!.env, projectionDir: dir, sessionDir: dir, secret: undefined });
      expect(env.BYOK_PI_MCP_CONFIG_PATH).toBe(captured!.env.BYOK_PI_MCP_CONFIG_PATH);
      expect(env.BYOK_PI_PERMISSION_MODE).toBe('readonly');
      expect(env.ZAI_API_KEY).toBeUndefined();
      expect(env.UNRELATED).toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
