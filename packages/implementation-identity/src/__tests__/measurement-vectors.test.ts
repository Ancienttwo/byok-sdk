import { describe, expect, it } from 'vitest';
import {
  loaderEnvInjections,
  PROVIDER_CREDENTIAL_ENV_DENY_NAMES,
  TOOL_IMPLEMENTATION_LAUNCH_ENV_LIFECYCLE_NAMES,
  toolImplementationLaunchEnvNamesDigest,
  toolImplementationLoaderEnvValuesDigest,
  unexpectedLaunchEnvControlNames,
} from '../index';

// Literal outputs captured from client authority at f25447d7 before extraction.
const env = {
  PATH: '/usr/bin', HOME: '/home/test', OPENAI_API_KEY: 'secret',
  BYOK_PRODUCT_ID: 'p', BYOK_HOST_TOOLSET_CONTEXT: 'nonce', BYOK_STORE_DIR: '/store',
  NODE_OPTIONS: '--require=/tmp/p.js', BUN_PRELOAD: 'x', node_options: 'mixed', BYOK_UNKNOWN: 'x',
};

describe('measurement extraction fixed vectors', () => {
  it('preserves names and loader digest bytes, including Windows name handling', () => {
    expect(toolImplementationLaunchEnvNamesDigest({})).toBe('4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
    expect(toolImplementationLoaderEnvValuesDigest({}, 'linux')).toBe('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a');
    expect(toolImplementationLaunchEnvNamesDigest(env)).toBe('0b6662cdad66de36d27d3912408e9d6a94bf19a0b0ea8c06f8e287b5473b14c7');
    expect(toolImplementationLoaderEnvValuesDigest(env, 'linux')).toBe('d81a7c2280013681c852e24ad497129b412bcf64c664e73a497845a6e4429673');
    expect(toolImplementationLoaderEnvValuesDigest(env, 'win32')).toBe('44f113c3544e506d00389f1a5133826e7cdaa0b35dab85a1e2512b56e120bb58');
  });

  it('keeps the projection fixed and unknown BYOK names denied', () => {
    expect(Object.isFrozen(PROVIDER_CREDENTIAL_ENV_DENY_NAMES)).toBe(true);
    expect(Object.isFrozen(TOOL_IMPLEMENTATION_LAUNCH_ENV_LIFECYCLE_NAMES)).toBe(true);
    expect(unexpectedLaunchEnvControlNames(env)).toEqual(['BYOK_UNKNOWN']);
    expect(loaderEnvInjections(env, 'linux')).toEqual(['BUN_PRELOAD', 'NODE_OPTIONS']);
    expect(loaderEnvInjections(env, 'win32')).toEqual(['BUN_PRELOAD', 'NODE_OPTIONS', 'node_options']);
    const projected = Object.fromEntries([...PROVIDER_CREDENTIAL_ENV_DENY_NAMES, ...TOOL_IMPLEMENTATION_LAUNCH_ENV_LIFECYCLE_NAMES].map((name) => [name, 'excluded']));
    expect(toolImplementationLaunchEnvNamesDigest(projected)).toBe('4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945');
    expect(toolImplementationLaunchEnvNamesDigest({ BYOK_UNKNOWN: 'x' })).not.toBe(toolImplementationLaunchEnvNamesDigest({}));
  });
});
