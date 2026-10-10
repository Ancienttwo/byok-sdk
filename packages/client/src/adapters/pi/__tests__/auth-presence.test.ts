/** Pi's non-secret login-state observation (`authPresent`), on both detect paths. */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { PROVIDER_CREDENTIAL_ENV_NAMES } from '../../provider-credential-environment';
import { probePiAuthPresent, resolvePiAgentDir } from '../auth-presence';
import { PiAdapter } from '../pi-adapter';

const FAKE_PI = fileURLToPath(new URL('../../../__tests__/fixtures/fake-pi.mjs', import.meta.url));
/** A product Pi asset root that holds the SDK asset manifest: the built package assets. */
const PRODUCT_ASSETS = fileURLToPath(new URL('../../../../dist/assets/', import.meta.url));
const SECRET = 'sk-canary-must-never-surface';
const OAUTH = { type: 'oauth', access: SECRET, refresh: SECRET, expires: 1_900_000_000_000 };
const API_KEY = { type: 'api_key', key: SECRET };

let agentDir: string;
beforeEach(async () => { agentDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-pi-auth-')); });
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(agentDir, { recursive: true, force: true });
});

async function write(name: 'auth.json' | 'settings.json' | 'models.json', content: unknown): Promise<void> {
  await fs.writeFile(path.join(agentDir, name), typeof content === 'string' ? content : JSON.stringify(content));
}
const probe = (extra: Record<string, string> = {}) => probePiAuthPresent({ PI_CODING_AGENT_DIR: agentDir, ...extra });

describe('resolvePiAgentDir', () => {
  test('follows pi: a non-empty PI_CODING_AGENT_DIR with ~ and file:// expanded, else ~/.pi/agent', () => {
    expect(resolvePiAgentDir({})).toBe(path.join(os.homedir(), '.pi', 'agent'));
    expect(resolvePiAgentDir({ PI_CODING_AGENT_DIR: '' })).toBe(path.join(os.homedir(), '.pi', 'agent'));
    expect(resolvePiAgentDir({ PI_CODING_AGENT_DIR: '/x/agent' })).toBe('/x/agent');
    expect(resolvePiAgentDir({ PI_CODING_AGENT_DIR: '~' })).toBe(os.homedir());
    expect(resolvePiAgentDir({ PI_CODING_AGENT_DIR: '~/custom' })).toBe(path.join(os.homedir(), 'custom'));
    expect(resolvePiAgentDir({ PI_CODING_AGENT_DIR: pathToFileURL(agentDir).href })).toBe(agentDir);
  });
});

describe('probePiAuthPresent', () => {
  test('a provider credential env-var name is enough, without any file', async () => {
    await expect(probe({ ZAI_API_KEY: '' })).resolves.toBe(true);
    await expect(probe()).resolves.toBe(false);
  });

  test('an auth.json login record of pi\'s oauth or api_key shape is login state', async () => {
    await write('auth.json', { zai: OAUTH });
    await expect(probe()).resolves.toBe(true);
    await write('auth.json', { 'openai-codex': API_KEY });
    await expect(probe()).resolves.toBe(true);
    // BOM-prefixed files are read as pi reads them.
    await write('auth.json', `﻿${JSON.stringify({ zai: OAUTH })}`);
    await expect(probe()).resolves.toBe(true);
  });

  test('missing, empty, malformed or shapeless auth.json observes false', async () => {
    await expect(probe()).resolves.toBe(false);
    for (const content of ['', '{', '[]', 'null', '"x"', {}, { zai: null }, { zai: [] }, { zai: { type: 'api_key' } },
      { zai: { type: 'api_key', key: '' } }, { zai: { type: 'oauth', access: SECRET } },
      { zai: { ...OAUTH, expires: 'soon' } }, { zai: { type: 'session', token: SECRET } }]) {
      await write('auth.json', content);
      await expect(probe(), JSON.stringify(content)).resolves.toBe(false);
    }
    // A directory where the file belongs is unreadable, not a throw.
    await fs.rm(path.join(agentDir, 'auth.json'));
    await fs.mkdir(path.join(agentDir, 'auth.json'));
    await expect(probe()).resolves.toBe(false);
  });

  test('a configured settings.json defaultProvider must itself hold the login', async () => {
    await write('auth.json', { zai: OAUTH });
    await write('settings.json', { defaultProvider: 'anthropic' });
    await expect(probe()).resolves.toBe(false);
    await write('settings.json', { defaultProvider: 'zai' });
    await expect(probe()).resolves.toBe(true);
    // A prototype name is never an own record.
    await write('settings.json', { defaultProvider: 'constructor' });
    await expect(probe()).resolves.toBe(false);
    // A valid settings.json with no usable default falls back to any provider.
    for (const settings of [{}, { defaultProvider: '' }, { defaultProvider: 7 }]) {
      await write('settings.json', settings);
      await expect(probe(), JSON.stringify(settings)).resolves.toBe(true);
    }
    // So does an absent settings.json.
    await fs.rm(path.join(agentDir, 'settings.json'));
    await expect(probe()).resolves.toBe(true);
  });

  test('an unreadable or malformed settings.json observes false even with a stored login', async () => {
    await write('auth.json', { zai: OAUTH });
    for (const settings of ['{', '[]', 'null', '"zai"']) {
      await write('settings.json', settings);
      await expect(probe(), settings).resolves.toBe(false);
    }
    await fs.rm(path.join(agentDir, 'settings.json'));
    await fs.mkdir(path.join(agentDir, 'settings.json'));
    await expect(probe()).resolves.toBe(false);
  });
});

describe('probePiAuthPresent: models.json provider apiKey', () => {
  const provider = (apiKey: unknown) => ({ providers: { magpie: { baseUrl: 'https://magpie.invalid/v1', api: 'openai-completions', apiKey } } });

  test('the defaultProvider\'s own models.json apiKey is login state, beside auth.json logins for other providers', async () => {
    await write('settings.json', { defaultProvider: 'magpie' });
    await write('auth.json', { zai: OAUTH, 'openai-codex': API_KEY });
    await expect(probe()).resolves.toBe(false);
    await write('models.json', provider(SECRET));
    await expect(probe()).resolves.toBe(true);
    // Without auth.json at all.
    await fs.rm(path.join(agentDir, 'auth.json'));
    await expect(probe()).resolves.toBe(true);
  });

  test('an env-var template or !command is configured as written: never resolved, never run', async () => {
    await write('settings.json', { defaultProvider: 'magpie' });
    const marker = path.join(agentDir, 'command-ran');
    for (const apiKey of ['MAGPIE_API_KEY_NOT_SET', '$MAGPIE_API_KEY_NOT_SET', '${MAGPIE_API_KEY_NOT_SET}', `!touch '${marker}'`]) {
      await write('models.json', provider(apiKey));
      await expect(probe(), apiKey).resolves.toBe(true);
    }
    await expect(fs.access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('a configured defaultProvider must itself carry the apiKey; with no default any provider does', async () => {
    await write('models.json', provider(SECRET));
    await write('settings.json', { defaultProvider: 'zai' });
    await expect(probe()).resolves.toBe(false);
    await write('settings.json', { defaultProvider: 'constructor' });
    await expect(probe()).resolves.toBe(false);
    for (const settings of [{}, { defaultProvider: '' }]) {
      await write('settings.json', settings);
      await expect(probe(), JSON.stringify(settings)).resolves.toBe(true);
    }
    await fs.rm(path.join(agentDir, 'settings.json'));
    await expect(probe()).resolves.toBe(true);
  });

  test('models.json is read as pi reads it: BOM, // comments and trailing commas', async () => {
    await write('settings.json', { defaultProvider: 'magpie' });
    await write('models.json', `\ufeff{
  // a custom provider
  "providers": {
    "magpie": { "baseUrl": "https://magpie.invalid/v1", "apiKey": "${SECRET}", },
  },
}`);
    await expect(probe()).resolves.toBe(true);
  });

  test('missing, malformed or shapeless models.json contributes nothing and never throws', async () => {
    await write('settings.json', { defaultProvider: 'magpie' });
    await expect(probe()).resolves.toBe(false);
    for (const content of ['', '{', '[]', 'null', {}, { providers: [] }, { providers: { magpie: null } },
      { providers: { magpie: [] } }, provider(''), provider(7), provider(null), { providers: { magpie: { baseUrl: 'https://magpie.invalid' } } }]) {
      await write('models.json', content);
      await expect(probe(), JSON.stringify(content)).resolves.toBe(false);
    }
    await fs.rm(path.join(agentDir, 'models.json'));
    await fs.mkdir(path.join(agentDir, 'models.json'));
    await expect(probe()).resolves.toBe(false);
    // A malformed models.json does not hide an auth.json login.
    await write('auth.json', { magpie: API_KEY });
    await expect(probe()).resolves.toBe(true);
  });

  test('a malformed auth.json or settings.json still observes false, as pi fails on them', async () => {
    await write('models.json', provider(SECRET));
    await write('auth.json', '{');
    await expect(probe()).resolves.toBe(false);
    await write('auth.json', {});
    await write('settings.json', '{');
    await expect(probe()).resolves.toBe(false);
  });
});

describe('PiAdapter.detect() authPresent', () => {
  beforeEach(() => {
    for (const name of PROVIDER_CREDENTIAL_ENV_NAMES) vi.stubEnv(name, undefined);
    vi.stubEnv('PI_CODING_AGENT_DIR', agentDir);
  });

  const installed = () => new PiAdapter({ resolveBin: () => ({ command: FAKE_PI, source: 'env' }) });
  const bundled = () => {
    vi.stubEnv('PI_PACKAGE_DIR', PRODUCT_ASSETS);
    return new PiAdapter({
      resolveBin: () => { throw new Error('a single-file product resolves no installed Pi package'); },
      sdkHelperHost: { mode: 'self-executable' },
    });
  };

  for (const [name, adapter] of [['installed', installed], ['sdkHelperHost', bundled]] as const) {
    test(`${name}: reflects pi's own auth.json login and env names, never surfacing a value`, async () => {
      const first = await adapter().detect();
      expect(first).toMatchObject({ kind: 'available', authPresent: false });

      await write('auth.json', { zai: OAUTH });
      const loggedIn = await adapter().detect();
      expect(loggedIn).toMatchObject({ kind: 'available', authPresent: true });
      expect(JSON.stringify(loggedIn)).not.toContain(SECRET);

      await write('auth.json', '{ not json');
      await expect(adapter().detect()).resolves.toMatchObject({ kind: 'available', authPresent: false });

      // #345: a models.json provider key for the default provider, auth.json holding only other providers.
      await write('auth.json', { zai: OAUTH });
      await write('settings.json', { defaultProvider: 'magpie' });
      await expect(adapter().detect()).resolves.toMatchObject({ kind: 'available', authPresent: false });
      await write('models.json', { providers: { magpie: { baseUrl: 'https://magpie.invalid/v1', apiKey: SECRET } } });
      const byModels = await adapter().detect();
      expect(byModels).toMatchObject({ kind: 'available', authPresent: true });
      expect(JSON.stringify(byModels)).not.toContain(SECRET);

      await write('auth.json', '{ not json');
      vi.stubEnv('ANTHROPIC_API_KEY', SECRET);
      const byEnv = await adapter().detect();
      expect(byEnv).toMatchObject({ kind: 'available', authPresent: true });
      expect(JSON.stringify(byEnv)).not.toContain(SECRET);
    });
  }
});
