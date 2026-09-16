import { describe, expect, it } from 'vitest';
import {
  assertImplementationSpawnBinding,
  parseImplementationSpawnBinding,
  projectKeysPiInheritedEnvironment,
  type ImplementationSpawnBindingV1,
} from './spawn-binding';
import { toolImplementationLaunchEnvNamesDigest, toolImplementationLoaderEnvValuesDigest } from './identity';

function binding(): ImplementationSpawnBindingV1 {
  return {
    format: 'byok.implementation-spawn', version: 1,
    identity: { kind: 'unavailable', reason: 'resolver_unconfigured' },
    command: '/release/bun', entry: '/release/sdk entry.js',
    fixedArgv: ['__byok_sdk_helper', 'pi-rpc'], cwd: '/sealed',
    envCommitments: { PI_PACKAGE_DIR: '/release/assets', PI_CODING_AGENT_DIR: '/projection' },
  };
}
function actual(launch: ImplementationSpawnBindingV1) {
  return {command:launch.command, entry:launch.entry, fixedArgv:launch.fixedArgv, cwd:launch.cwd,
    env:{PATH:'/usr/bin', ...launch.envCommitments}};
}

describe('physical spawn binding', () => {
  it('accepts exact explicit resolver-unconfigured inputs without manufacturing an attestation', async () => {
    const launch = parseImplementationSpawnBinding(binding());
    expect(launch?.identity).toEqual({kind:'unavailable',reason:'resolver_unconfigured'});
    await expect(assertImplementationSpawnBinding(launch!,actual(launch!))).resolves.toBeUndefined();
    expect(Object.isFrozen(launch?.fixedArgv)).toBe(true);
    expect(Object.isFrozen(launch?.envCommitments)).toBe(true);
  });

  it.each(['command', 'entry', 'fixedArgv', 'cwd', 'undeclared-directory', 'changed-directory'] as const)(
    'refuses %s drift at the final boundary', async (field) => {
      const launch = binding();
      const input = actual(launch);
      const changed = {
        ...input,
        ...(field === 'command' ? {command:'/other/bun'} : {}),
        ...(field === 'entry' ? {entry:'/other/entry.js'} : {}),
        ...(field === 'fixedArgv' ? {fixedArgv:['__byok_sdk_helper','pi-prepared']} : {}),
        ...(field === 'cwd' ? {cwd:'/writable/session'} : {}),
        ...(field === 'undeclared-directory' ? {env:{...input.env,PI_CODING_AGENT_SESSION_DIR:'/undeclared'}} : {}),
        ...(field === 'changed-directory' ? {env:{...input.env,PI_PACKAGE_DIR:'/writable/assets'}} : {}),
      };
      await expect(assertImplementationSpawnBinding(launch,changed)).rejects.toThrow(
        field.endsWith('directory') ? /undeclared or changed Pi directory/ : /launch description drift/,
      );
    },
  );

  it('rejects unavailable reasons other than resolver-unconfigured and rejects extra authority fields', () => {
    for (const reason of ['implementation_identity_unattested','install_record_mismatch','reverify_failed']) {
      expect(parseImplementationSpawnBinding({...binding(),identity:{kind:'unavailable',reason}})).toBeUndefined();
    }
    expect(parseImplementationSpawnBinding({...binding(),fallbackCommand:'/other'})).toBeUndefined();
    expect(parseImplementationSpawnBinding({...binding(),envCommitments:{BYOK_PI_PERMISSION_MODE:'auto'}})).toBeUndefined();
  });

  it('copies commitments at parsing so later source mutation cannot redefine the expected env', async () => {
    const raw = {...binding(),envCommitments:{PI_PACKAGE_DIR:'/release/assets'}};
    const parsed = parseImplementationSpawnBinding(raw)!;
    raw.envCommitments.PI_PACKAGE_DIR = '/changed-after-admission';
    expect(parsed.envCommitments.PI_PACKAGE_DIR).toBe('/release/assets');
    await expect(assertImplementationSpawnBinding(parsed,{...actual(parsed),env:raw.envCommitments})).rejects.toThrow(/changed Pi directory/);
  });

  it('shares a closed platform env projection and excludes injected credentials from measured inputs', () => {
    const projected = projectKeysPiInheritedEnvironment({
      PATH:'/usr/bin',HOME:'/home',LC_ALL:'C',XDG_CACHE_HOME:'/cache',
      PI_PACKAGE_DIR:'/ambient',PI_CODING_AGENT_DIR:'/ambient',BYOK_PI_PERMISSION_MODE:'auto',
      NODE_OPTIONS:'--require=/bad.js',OPENAI_API_KEY:'ambient',PI_PROVIDER_API_KEY:'ambient',SystemRoot:'C:\\Windows',
    },'linux');
    expect(projected).toEqual({PATH:'/usr/bin',HOME:'/home',LC_ALL:'C',XDG_CACHE_HOME:'/cache'});
    const credentialEnv = {...projected,PI_PROVIDER_API_KEY:'custody-canary-not-an-identity-input'};
    expect(toolImplementationLaunchEnvNamesDigest(credentialEnv)).toBe(toolImplementationLaunchEnvNamesDigest(projected));
    expect(toolImplementationLoaderEnvValuesDigest(credentialEnv)).toBe(toolImplementationLoaderEnvValuesDigest(projected));
    expect(projectKeysPiInheritedEnvironment({path:'C:\\bin',systemroot:'C:\\Windows',lc_all:'C',pi_package_dir:'C:\\bad'},'win32'))
      .toEqual({path:'C:\\bin',systemroot:'C:\\Windows',lc_all:'C'});
  });
});
