import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

import { InMemorySecretStore, modelProviderSecretName } from './secret-store';
import {
  parsePiProviderLauncherOptions,
  buildPiProviderChildEnvironment,
  ensurePiSessionDirectory,
  resolvePiProviderSecret,
} from './pi-provider-launcher-core';
import { parseModelProviderProfile } from './provider-profile';

const timestamps = {
  created_at: '2026-08-12T00:00:00.000Z',
  updated_at: '2026-08-12T00:00:00.000Z',
};

function profile(authMode: 'bearer' | 'none') {
  return parseModelProviderProfile({
    ...timestamps,
    adapter: 'openai_compatible',
    auth_mode: authMode,
    base_url: 'http://127.0.0.1:11434/v1',
    display_name: 'Local model',
    enabled: true,
    kind: 'model',
    model: 'local-model',
    provider_id: 'custom',
  });
}

describe('Pi provider launcher core', () => {
  it('parses only the closed launcher contract and requires absolute custody paths', () => {
    const profileDbPath = path.join(os.tmpdir(), 'providers.sqlite');
    const sessionDir = path.join(os.tmpdir(), 'pi-sessions');
    expect(parsePiProviderLauncherOptions([
      '--pi-bin',
      '/opt/pi',
      '--profile-db',
      profileDbPath,
      '--session-dir',
      sessionDir,
      '--provider',
      'custom',
      '--model',
      'local-model',
      '--',
      '--mode',
      'rpc',
    ])).toMatchObject({ profileDbPath, sessionDir, providerId: 'custom' });

    expect(() => parsePiProviderLauncherOptions([
      '--pi-bin', '/opt/pi',
      '--profile-db', 'providers.sqlite',
      '--session-dir', sessionDir,
      '--provider', 'custom',
      '--model', 'local-model',
      '--', '--mode', 'rpc',
    ])).toThrow(/absolute paths/);

    expect(() => parsePiProviderLauncherOptions([
      '--pi-bin', '/opt/pi',
      '--profile-db', profileDbPath,
      '--session-dir', sessionDir,
      '--provider', 'custom',
      '--model', 'local-model\nforged-log',
      '--', '--mode', 'rpc',
    ])).toThrow(/single-line/);
  });

  it('does not construct or require a keychain for auth-free providers', async () => {
    const createStore = vi.fn(() => new InMemorySecretStore());
    await expect(resolvePiProviderSecret(profile('none'), createStore)).resolves.toBeUndefined();
    expect(createStore).not.toHaveBeenCalled();
  });

  it('reads the exact provider secret and fails closed when it is absent', async () => {
    const store = new InMemorySecretStore();
    await store.set(modelProviderSecretName('custom'), 'secret-value');
    await expect(resolvePiProviderSecret(profile('bearer'), () => store)).resolves.toBe('secret-value');

    await expect(
      resolvePiProviderSecret(profile('bearer'), () => new InMemorySecretStore()),
    ).rejects.toMatchObject({ code: 'PROVIDER_SECRET_MISSING' });
  });

  it('builds the Pi child environment from a closed baseline plus only the resolved key', () => {
    expect(buildPiProviderChildEnvironment({
      ambient: {
        PATH: '/usr/bin',
        HTTPS_PROXY: 'http://proxy.example',
        OPENAI_API_KEY: 'ambient-provider-key',
        AWS_SECRET_ACCESS_KEY: 'ambient-cloud-key',
        GITHUB_TOKEN: 'ambient-other-secret',
        PI_PROVIDER_API_KEY: 'ambient-projection-key',
      },
      projectionDir: '/private/projection',
      sessionDir: '/private/sessions',
      secret: 'exact-custody-key',
      platform: 'darwin',
    })).toEqual({
      PATH: '/usr/bin',
      HTTPS_PROXY: 'http://proxy.example',
      PI_CODING_AGENT_DIR: '/private/projection',
      PI_CODING_AGENT_SESSION_DIR: '/private/sessions',
      PI_PROVIDER_API_KEY: 'exact-custody-key',
    });
  });

  it('secures a newly created session directory without chmodding an existing host directory', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-pi-session-dir-'));
    try {
      const existing = path.join(root, 'existing');
      await fs.mkdir(existing, { mode: 0o700 });
      await ensurePiSessionDirectory(existing);
      if (process.platform !== 'win32') {
        expect((await fs.stat(existing)).mode & 0o777).toBe(0o700);
        const unsafeExisting = path.join(root, 'unsafe-existing');
        await fs.mkdir(unsafeExisting, { mode: 0o755 });
        await fs.chmod(unsafeExisting, 0o755);
        await expect(ensurePiSessionDirectory(unsafeExisting)).rejects.toThrow(/owner-only/);
        expect((await fs.stat(unsafeExisting)).mode & 0o777).toBe(0o755);
      }

      const created = path.join(root, 'new', 'sessions');
      await ensurePiSessionDirectory(created);
      if (process.platform !== 'win32') {
        expect((await fs.stat(created)).mode & 0o777).toBe(0o700);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
