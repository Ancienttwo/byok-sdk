import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthManager } from '../daemon/auth-manager';
import { DeviceCredentialStore, type DeviceCommandRunner } from '../daemon/device-credential-store';
import { DeviceStore } from '../daemon/store';
import { InMemoryDeviceCredentialStore } from './fixtures/credential-backend';
import { TestServer } from './fixtures/test-server';

describe.each(['OS entry', 'injected backend'] as const)('replacement pairing preserves the current enrollment until success (%s)', (backend) => {
  let server: TestServer;
  let root: string;
  const auths: AuthManager[] = [];
  beforeEach(async () => {
    server = await TestServer.start();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-replacement-credential-'));
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(auths.splice(0).map(auth => auth.stop()));
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each(['rejected', 'network', 'invalid-response'] as const)('keeps the old authority after a %s replacement and retries the staged key', async (failure) => {
    const injected = new InMemoryDeviceCredentialStore();
    let value: string | undefined;
    const run: DeviceCommandRunner = async (_executable, args, stdin) => {
      if (args[0] === 'lookup') return { exitCode: value === undefined ? 1 : 0, stdout: value ?? '', stderr: '' };
      if (args[0] === 'clear') value = undefined;
      else value = stdin;
      return { exitCode: 0, stdout: '', stderr: '' };
    };
    const make = (name: string) => {
      const storeDir = path.join(root, name);
      const credentials = backend === 'injected backend' ? injected
        : new DeviceCredentialStore({ storeDir, productId: 'replacement-test', platform: 'linux', commandRunner: run });
      const auth = new AuthManager({ serverUrl: server.url, store: new DeviceStore(storeDir, credentials) });
      auths.push(auth);
      return { auth, credentials };
    };
    const original = make('original');
    const prior = await original.auth.pair('pairing-code');
    const replacement = make('replacement');
    const nativeFetch = globalThis.fetch;
    let attemptedKey: string | undefined;
    vi.stubGlobal('fetch', (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/byok/pair')) {
        attemptedKey = JSON.parse(String(init?.body)).devicePublicKey;
        if (failure === 'network') throw new Error('test network unavailable');
        return new Response(JSON.stringify(failure === 'rejected' ? { error: 'invalid pairing code' } : {}), {
          status: failure === 'rejected' ? 403 : 200, headers: { 'content-type': 'application/json' },
        });
      }
      return nativeFetch(input, init);
    }) as typeof fetch);
    await expect(replacement.auth.pair('pairing-code', { replaceOtherStore: true })).rejects.toThrow();
    const retained = await original.credentials.read();
    expect(retained?.deviceId).toBe(prior.deviceId);
    expect(retained?.devicePrivateKeyPem === prior.devicePrivateKeyPem).toBe(true);
    expect(retained?.accessToken === prior.accessToken).toBe(true);
    expect(attemptedKey).not.toBe(prior.devicePublicKey);
    expect((await replacement.credentials.readFirstPairingAttempt())?.devicePublicKey).toBe(attemptedKey);

    vi.unstubAllGlobals();
    // Renewal of the still-current enrollment must not erase the pending key.
    await original.auth.handleUnauthorized();
    expect((await replacement.credentials.readFirstPairingAttempt())?.devicePublicKey).toBe(attemptedKey);
    const restarted = make('replacement');
    const promoted = await restarted.auth.pair('pairing-code', { replaceOtherStore: true });
    expect(promoted.devicePublicKey).toBe(attemptedKey);
    expect(promoted.deviceId).not.toBe(prior.deviceId);
    expect((await original.credentials.read())?.deviceId).toBe(promoted.deviceId);
    expect(await restarted.credentials.readFirstPairingAttempt()).toBeUndefined();
  });
});
