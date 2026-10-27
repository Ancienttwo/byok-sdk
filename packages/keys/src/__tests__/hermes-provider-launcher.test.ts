import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hermesProviderModel, parseHermesProviderLauncherRequest, runHermesProviderLauncher } from '../hermes-provider-launcher';
import { parseModelProviderProfile } from '../provider-profile';
import { exactProviderProfileBinding } from '../provider-profile-binding';
import { SqliteProviderProfileStore } from '../sqlite-profile-store';

const profile = parseModelProviderProfile({ created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', adapter: 'openai_compatible', auth_mode: 'bearer', base_url: 'https://example.test/v1', capabilities: [], display_name: 'Fake', enabled: true, kind: 'model', model: 'fake-model', profile_ref: 'custom', provider_kind: 'custom' });
const binding = exactProviderProfileBinding(profile, []);
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true }); });
describe('Hermes custody contract', () => {
  it('accepts only bounded exact SDK launcher grammar', () => {
    const request = { profileDbPath: '/tmp/fake.sqlite', binding };
    expect(parseHermesProviderLauncherRequest(['--hermes-custody-request', JSON.stringify(request)])).toEqual(request);
    for (const invalid of [{ ...request, secret: 'fake' }, { ...request, launch: { hermesBin: 'hermes', home: '/tmp/home', role: 'gateway' } }, { ...request, binding: { ...binding, profileHash: 'bad' } }]) expect(() => parseHermesProviderLauncherRequest(['--hermes-custody-request', JSON.stringify(invalid)])).toThrow();
    expect(() => parseHermesProviderLauncherRequest(['--hermes-custody-request', JSON.stringify(request), '--extra'])).toThrow();
    expect(() => parseHermesProviderLauncherRequest(['--hermes-custody-request', ' '.repeat(16385)])).toThrow();
  });
  it('maps bearer OpenAI profiles but refuses disabled, unauthenticated, Anthropic and Pi-specific semantics', () => {
    expect(hermesProviderModel(profile)).toEqual({ provider: 'custom', model: 'fake-model', baseUrl: 'https://example.test/v1', keyEnv: 'SDK_HERMES_PROVIDER_KEY' });
    for (const unsupported of [{ ...profile, enabled: false }, { ...profile, auth_mode: 'none' as const }, { ...profile, adapter: 'anthropic' as const }, parseModelProviderProfile({ ...profile, pi_model: { api: 'openai-responses', contextWindow: 1000, maxTokens: 100, reasoning: false, thinkingLevel: 'off', thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: null }, compat: {} } })]) expect(() => hermesProviderModel(unsupported)).toThrow();
  });
  it('admission reads no credentials and fails on pending custody', async () => {
    const dir = await fs.mkdtemp(process.platform === 'win32' ? path.join(os.tmpdir(), 'bhk-') : '/tmp/bhk-'); dirs.push(dir);
    const profileDbPath = `${dir}/profiles.sqlite`;
    const store = new SqliteProviderProfileStore({ path: profileDbPath });
    await store.save(profile);
    const createSecretStore = vi.fn(() => { throw Error('must not read credentials at admission'); });
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await runHermesProviderLauncher({ profileDbPath, binding }, { createSecretStore });
      expect(stdout).toHaveBeenCalledWith(`${JSON.stringify(hermesProviderModel(profile))}\n`);
      expect(createSecretStore).not.toHaveBeenCalled();
      await store.markPending({ profileRef: profile.profile_ref, operation: 'configure', requestId: null, requestDigest: null, operationGeneration: null, since: profile.updated_at });
      await expect(runHermesProviderLauncher({ profileDbPath, binding }, { createSecretStore })).rejects.toThrow();
      expect(createSecretStore).not.toHaveBeenCalled();
    } finally { await store.close(); }
  });
});
