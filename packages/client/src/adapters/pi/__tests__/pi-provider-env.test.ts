import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findEnvKeys } from '@earendil-works/pi-ai/compat';
import { getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import { MODEL_PROVIDER_VENDORS } from '../../../../../keys/src/provider-catalog';
import {
  CODEX_AUTH_ENV_NAMES,
  PI_AMBIENT_CREDENTIAL_ENV_NAMES,
  PI_PROJECTED_KEY_ENV,
  PROVIDER_CREDENTIAL_ENV_DENY_NAMES,
} from '../../provider-credential-environment';
import { PI_PROVIDER_ENV_KEYS, PI_PROVIDER_ENV_KEY_NAMES } from '../pi-provider-env.generated';

/**
 * #384/#396: the pinned pi owns its credential env names. The SDK holds them
 * as generated data (so the adapters entry never imports pi) and these checks
 * fail the day that data, or the classification of a name pi reads, drifts.
 */
const PACKAGE_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const everyName = new Proxy({}, { get: (_target, key) => (typeof key === 'string' ? 'present' : undefined) });

function piAiRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-ai/compat')));
  while (!existsSync(path.join(dir, 'package.json'))) dir = path.dirname(dir);
  return dir;
}

describe('(a) the generated data against the live pinned pi', () => {
  it('equals what findEnvKeys reports for every built-in provider', () => {
    const live = Object.fromEntries(
      getBuiltinProviders().map((id) => [id, [...(findEnvKeys(id, everyName) ?? [])].sort()]),
    );
    expect(PI_PROVIDER_ENV_KEYS).toEqual(live);
    expect([...PI_PROVIDER_ENV_KEY_NAMES]).toEqual([...new Set(Object.values(live).flat())].sort());
    expect(PI_PROVIDER_ENV_KEY_NAMES).toContain('MOONSHOT_API_KEY');
  });

  it('names the pinned pi-ai version in its header', () => {
    const manifest = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
    const header = readFileSync(path.join(PACKAGE_ROOT, 'src/adapters/pi/pi-provider-env.generated.ts'), 'utf8').split('\n')[0];
    expect(header).toContain(`from pi-ai ${manifest.dependencies['@earendil-works/pi-ai']}.`);
    expect(manifest.dependencies['@earendil-works/pi-ai']).toBe(manifest.byok.piRuntimePin);
  });

  it('is what the generator emits (regenerate or fail)', () => {
    const script = path.join(PACKAGE_ROOT, 'scripts/generate-pi-provider-env.mjs');
    expect(() => execFileSync(process.execPath, [script, '--check'], { stdio: 'pipe' })).not.toThrow();
  });
});

/**
 * Names pi reads that are configuration, not credentials. Each is a conscious
 * choice: they are neither admitted to the prepared launch (they could change
 * request bytes or routing) nor denied to children.
 */
const NON_CREDENTIAL_ENV_NAMES = new Set([
  'ANTHROPIC_FEDERATION_RULE_ID', 'ANTHROPIC_ORGANIZATION_ID', 'ANTHROPIC_SERVICE_ACCOUNT_ID', 'ANTHROPIC_WORKSPACE_ID',
  'AWS_BEDROCK_FORCE_CACHE', 'AWS_BEDROCK_FORCE_HTTP1', 'AWS_BEDROCK_SKIP_AUTH',
  // Named profile and container credential endpoints: they select where
  // credentials come from; the secret itself is never in the variable.
  'AWS_CONTAINER_CREDENTIALS_FULL_URI', 'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_PROFILE',
  'AWS_DEFAULT_REGION', 'AWS_REGION',
  'AZURE_OPENAI_API_VERSION', 'AZURE_OPENAI_BASE_URL', 'AZURE_OPENAI_DEPLOYMENT_NAME_MAP', 'AZURE_OPENAI_RESOURCE_NAME',
  'GCLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_CLOUD_PROJECT',
  'KIMI_CODE_OAUTH_HOST', 'KIMI_OAUTH_HOST', 'PI_CACHE_RETENTION', 'PI_OAUTH_CALLBACK_HOST',
]);

function distFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return distFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

describe('(b) every env name the pinned pi source reads is classified', () => {
  const classified = new Set<string>([
    ...PROVIDER_CREDENTIAL_ENV_DENY_NAMES,
    ...NON_CREDENTIAL_ENV_NAMES,
  ]);

  it('finds each literal getProviderEnvValue name and exported *_ENV constant in either set', () => {
    const scanned = new Set<string>();
    for (const file of distFiles(path.join(piAiRoot(), 'dist'))) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/getProviderEnvValue\(\s*["']([A-Z][A-Z0-9_]+)["']/g)) scanned.add(match[1]!);
      for (const match of text.matchAll(/export const [A-Z0-9_]*_ENV\s*=\s*["']([A-Z][A-Z0-9_]+)["']/g)) scanned.add(match[1]!);
    }
    // An empty or partial scan must not pass: today pi reads well over 20.
    expect(scanned.size).toBeGreaterThanOrEqual(20);
    expect([...scanned].filter((name) => !classified.has(name)).sort()).toEqual([]);
    // The two sets stay disjoint, so a name has one meaning.
    expect([...NON_CREDENTIAL_ENV_NAMES].filter((name) => PROVIDER_CREDENTIAL_ENV_DENY_NAMES.includes(name))).toEqual([]);
  });
});

describe('(c) the keys provider catalog against the generated map', () => {
  it('lists every api_key_env under its pi provider id', () => {
    for (const [id, vendor] of Object.entries(MODEL_PROVIDER_VENDORS)) {
      expect(PI_PROVIDER_ENV_KEYS[id], id).toContain(vendor.api_key_env);
    }
  });
});

describe('the deny set', () => {
  it('is the generated names plus the justified extras, without repeats', () => {
    const expected = [
      ...PI_PROVIDER_ENV_KEY_NAMES,
      ...PI_AMBIENT_CREDENTIAL_ENV_NAMES,
      ...CODEX_AUTH_ENV_NAMES,
      PI_PROJECTED_KEY_ENV,
    ];
    expect([...PROVIDER_CREDENTIAL_ENV_DENY_NAMES]).toEqual(expected);
    expect(new Set(PROVIDER_CREDENTIAL_ENV_DENY_NAMES).size).toBe(PROVIDER_CREDENTIAL_ENV_DENY_NAMES.length);
    expect(PROVIDER_CREDENTIAL_ENV_DENY_NAMES).toContain('PI_PROVIDER_API_KEY');
    for (const name of ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_WEB_IDENTITY_TOKEN_FILE', 'ANTHROPIC_IDENTITY_TOKEN_FILE', 'GOOGLE_APPLICATION_CREDENTIALS']) {
      expect(PROVIDER_CREDENTIAL_ENV_DENY_NAMES, name).toContain(name);
    }
  });
});
