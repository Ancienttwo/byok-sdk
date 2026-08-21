import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDaemon, type DaemonConfig } from '../daemon/create-daemon';

function config(piByokLauncher: DaemonConfig['piByokLauncher']): DaemonConfig {
  return {
    localAgentRelease: { version: '0.0.0-test' }, productName: 'Test',
    productId: 'pi-launcher-config-test',
    serverUrl: 'http://127.0.0.1:1',
    workspaceRoot: path.join(os.tmpdir(), 'byok-pi-launcher-workspaces'),
    storeDir: path.join(os.tmpdir(), 'byok-pi-launcher-store'),
    piByokLauncher,
  };
}

describe('DaemonConfig.piByokLauncher', () => {
  it('rejects empty or relative custody paths at daemon construction', () => {
    expect(() =>
      createDaemon(
        config({
          command: 'byok-pi-provider-launcher',
          profileDbPath: 'providers.sqlite',
          sessionDir: '/private/pi-sessions',
        }),
      ),
    ).toThrow(/must be absolute paths/);
    expect(() =>
      createDaemon(
        config({
          command: '',
          profileDbPath: '/private/providers.sqlite',
          sessionDir: '/private/pi-sessions',
        }),
      ),
    ).toThrow(/command must be a non-empty/);
  });

  it('rejects fixed args that could override authoritative launcher fields', () => {
    expect(() =>
      createDaemon(
        config({
          command: 'node',
          args: ['/opt/launcher.js', '--provider', 'other'],
          profileDbPath: '/private/providers.sqlite',
          sessionDir: '/private/pi-sessions',
        }),
      ),
    ).toThrow(/reserved launcher argument --provider/);
  });
});
