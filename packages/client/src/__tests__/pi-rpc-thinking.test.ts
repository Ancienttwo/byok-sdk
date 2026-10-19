import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
// Test-only imports. The shipped client does not depend on keys.
import { PI_MODEL_FIXTURE } from '../../../keys/src/fixtures/pi-model-config';
import { parseModelProviderProfile } from '../../../keys/src/provider-profile';
import { InMemoryProviderProfileStore } from '../../../keys/src/profile-store';
import { InMemorySecretStore } from '../../../keys/src/secret-store';
import { parsePiProviderLauncherOptions, startPiProvider } from '../../../keys/src/pi-provider-launcher-core';

const helper = path.resolve(import.meta.dirname, '../../dist/bin/byok-pi-rpc.js');
const digest = '0'.repeat(64);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

describe('Pi RPC thinking level boundary (#515)', () => {
  it.each(['low', 'high', 'max'] as const)('passes a schema-valid GLM profile with %s through the real launcher and helper', async thinkingLevel => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-thinking-')));
    roots.push(root);
    const projection = path.join(root, 'projection');
    await fs.mkdir(projection, { mode: 0o700 });
    const profile = parseModelProviderProfile({
      adapter: 'openai_compatible', auth_mode: 'none', base_url: 'http://127.0.0.1:9/v1',
      capabilities: [], created_at: '2026-10-19T00:00:00.000Z', updated_at: '2026-10-19T00:00:00.000Z',
      display_name: 'GLM probe', enabled: true, kind: 'model', model: 'glm-5.3-flash',
      profile_ref: 'glm-probe', provider_kind: 'custom', pi_model: { ...PI_MODEL_FIXTURE, thinkingLevel },
    });
    const profiles = new InMemoryProviderProfileStore();
    await profiles.save(profile);
    const options = parsePiProviderLauncherOptions([
      '--pi-bin', process.execPath, '--pi-entry', helper, '--runtime-entry', 'pi-rpc',
      '--profile-db', path.join(root, 'profiles.sqlite'), '--session-dir', path.join(root, 'sessions'),
      '--provider', profile.profile_ref, '--model', profile.model,
      '--pi-cwd', root, '--pi-projection-dir', projection, '--pi-config-digest', digest,
      '--', '--config', path.join(root, 'missing.json'), '--mode', 'rpc',
    ]);
    let stderr = '';
    let childArgs: string[] = [];
    const launched = await startPiProvider(profile, options, {
      ambient: { PATH: process.env.PATH, HOME: root }, profiles,
      createSecretStore: () => new InMemorySecretStore(),
      spawn: (command, args, spawnOptions) => {
        childArgs = args;
        // Run the real helper. Capture only its output; keep the IPC channel.
        const child = spawn(command, args, { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], signal: AbortSignal.timeout(15_000) });
        child.stderr!.on('data', chunk => { stderr += chunk; });
        child.stdout!.resume();
        return child;
      },
    });
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        launched.child.once('error', reject);
        launched.child.once('close', resolve);
      });
      expect(childArgs.slice(-2)).toEqual(['--thinking', thinkingLevel]);
      expect(stderr).not.toContain('invalid --thinking level');
      // A missing config proves parser admission without credentials or a provider call.
      // It does not prove a full session can start.
      expect(stderr).toContain('ENOENT');
      expect(code).toBe(1);
    } finally {
      launched.child.kill();
      await launched.cleanup();
    }
  }, 20_000);

  it.each(['invalid', 'MAX', 'maxx'])('keeps invalid level %s rejected by the built helper', thinking => {
    const child = spawnSync(process.execPath, [
      helper, `--config-digest=${digest}`, '--config', path.join(os.tmpdir(), 'missing-pi-thinking.json'),
      '--mode', 'rpc', '--thinking', thinking,
    ], { encoding: 'utf8', timeout: 15_000, env: { PATH: process.env.PATH, HOME: os.tmpdir() } });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(78);
    expect(child.stderr).toContain('invalid --thinking level');
    expect(child.stderr).not.toContain('ENOENT');
  }, 20_000);
});
