import { expect, it } from 'vitest';
import * as shared from '@byok-sdk/implementation-identity';
import * as client from '../daemon/tool-implementation-identity';
import { loaderEnvInjections, LOADER_ENV_DENY_PATTERNS } from '../daemon/environment';
import { PROVIDER_CREDENTIAL_ENV_DENY_NAMES, PROVIDER_CREDENTIAL_ENV_NAMES, withoutProviderCredentials } from '../adapters/provider-credential-environment';

it('projects one measurement implementation and classifier into client', () => {
  for (const name of [
    'resolveToolImplementationIdentity', 'reverifyToolImplementationIdentity',
    'assertToolImplementationBeforeSpawn', 'parseToolImplementationIdentity',
    'ToolImplementationReverifyError', 'toolImplementationLaunchEnvNamesDigest',
    'toolImplementationLoaderEnvValuesDigest',
  ] as const) expect(client[name]).toBe(shared[name]);
  expect(loaderEnvInjections).toBe(shared.loaderEnvInjections);
  expect(LOADER_ENV_DENY_PATTERNS).toBe(shared.LOADER_ENV_DENY_PATTERNS);
  expect(PROVIDER_CREDENTIAL_ENV_DENY_NAMES).toBe(shared.PROVIDER_CREDENTIAL_ENV_DENY_NAMES);
});

it('retains the client legacy allow policy and strips the shared complete deny inventory', () => {
  expect(PROVIDER_CREDENTIAL_ENV_NAMES).toHaveLength(11);
  expect(PROVIDER_CREDENTIAL_ENV_NAMES).not.toContain('PI_PROVIDER_API_KEY');
  const ambient: Record<string, string> = { PATH: '/usr/bin', ...Object.fromEntries(PROVIDER_CREDENTIAL_ENV_DENY_NAMES.map((name) => [name, 'secret'])) };
  expect(withoutProviderCredentials(ambient)).toEqual({ PATH: '/usr/bin' });
  expect(ambient.PI_PROVIDER_API_KEY).toBe('secret');
});
