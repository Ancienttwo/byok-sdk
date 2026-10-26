import { testAgentHomeConfig } from './fixtures/test-agent';
import { testScratchRoot } from "./fixtures/execution-scratch";
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDaemon, type DaemonConfig } from '../daemon/create-daemon';

function config(piByokLauncher: DaemonConfig['piByokLauncher']): DaemonConfig {
  return {
    localAgentRelease: { version: '0.0.0-test' }, productName: 'Test',
    productId: 'pi-launcher-config-test',
    serverUrl: 'http://127.0.0.1:1',
    agentHome: testAgentHomeConfig(),
    storeDir: path.join(os.tmpdir(), 'byok-pi-launcher-store'),
    piByokLauncher,
  };
}

describe('DaemonConfig.piByokLauncher', () => {
  it('durablePi refuses missing home, journal or custody configuration before daemon work', () => {
    expect(() => createDaemon({ storage: { scratchRoot: testScratchRoot() },  ...config(undefined), durablePi: true })).toThrow('durablePi requires');
    expect(() => createDaemon({ storage: { scratchRoot: testScratchRoot() },  ...config(undefined), durablePi: 'true' as never })).toThrow('durablePi must be boolean');
  });
  it('rejects empty or relative custody paths at daemon construction', () => {
    expect(() =>
      createDaemon(
        { storage: { scratchRoot: testScratchRoot() }, ...(config({
          command: 'byok-pi-provider-launcher',
          profileDbPath: 'providers.sqlite',
          sessionDir: '/private/pi-sessions',
        })) },
      ),
    ).toThrow(/must be absolute paths/);
    expect(() =>
      createDaemon(
        { storage: { scratchRoot: testScratchRoot() }, ...(config({
          command: '',
          profileDbPath: '/private/providers.sqlite',
          sessionDir: '/private/pi-sessions',
        })) },
      ),
    ).toThrow(/command must be a non-empty/);
  });

  it('rejects fixed args that could override authoritative launcher fields', () => {
    expect(() =>
      createDaemon(
        { storage: { scratchRoot: testScratchRoot() }, ...(config({
          command: 'node',
          args: ['/opt/launcher.js', '--provider', 'other'],
          profileDbPath: '/private/providers.sqlite',
          sessionDir: '/private/pi-sessions',
        })) },
      ),
    ).toThrow(/reserved launcher argument --provider/);
  });

  it('requires an explicit macOS keychain path to be absolute, non-empty, and single-line', () => {
    const baseLauncher = {
      command: 'byok-pi-provider-launcher',
      profileDbPath: '/private/providers.sqlite',
      sessionDir: '/private/pi-sessions',
    };

    expect(() => createDaemon({ storage: { scratchRoot: testScratchRoot() }, ...(config({
      ...baseLauncher,
      macosKeychainPath: 'Library/Keychains/login.keychain-db',
    })) })).toThrow(/macosKeychainPath must be an absolute path/);
    expect(() => createDaemon({ storage: { scratchRoot: testScratchRoot() }, ...(config({
      ...baseLauncher,
      macosKeychainPath: '',
    })) })).toThrow(/macosKeychainPath must be a non-empty single-line string/);
    expect(() => createDaemon({ storage: { scratchRoot: testScratchRoot() }, ...(config({
      ...baseLauncher,
      macosKeychainPath: '/private/keychains/login\n.keychain-db',
    })) })).toThrow(/macosKeychainPath must be a non-empty single-line string/);
  });

  it('rejects fixed args that could spoof the explicit macOS keychain path', () => {
    expect(() => createDaemon({ storage: { scratchRoot: testScratchRoot() }, ...(config({
      command: 'byok-pi-provider-launcher',
      args: ['--macos-keychain-path', '/private/other.keychain-db'],
      profileDbPath: '/private/providers.sqlite',
      sessionDir: '/private/pi-sessions',
      macosKeychainPath: '/private/login.keychain-db',
    })) })).toThrow(/reserved launcher argument --macos-keychain-path/);
  });
});
