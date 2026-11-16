import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pairDeviceDigest } from '@byok-sdk/protocol';
import { AuthManager, AuthResponseInvalidError } from '../daemon/auth-manager';
import { PairingBusyError, PairingCodeRejectedError, PairingInputInvalidError, PairingSupersededError } from '../daemon/daemon-errors';
import { DeviceCredentialStore, type DeviceCommandRunner } from '../daemon/device-credential-store';
import { publicKeyOfPrivateKeyPem } from '../daemon/device-keys';
import { acquireEnrollmentGate } from '../daemon/enrollment-gate';
import { DeviceRecordRePairRequiredError } from '../daemon/store';
import { DeviceStore } from '../daemon/store';
import { InMemoryDeviceCredentialBackend } from './fixtures/credential-backend';
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
    const injected = new InMemoryDeviceCredentialBackend();
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
      const auth = new AuthManager({ serverUrl: server.url, store: new DeviceStore('replacement-test', storeDir, credentials) });
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
    expect(retained).toEqual(prior);
    expect(attemptedKey).not.toBe(prior.devicePublicKey);
    const staged = await replacement.credentials.readPairingAttempt();
    expect(staged && publicKeyOfPrivateKeyPem(staged.devicePrivateKeyPem)).toBe(attemptedKey);

    vi.unstubAllGlobals();
    // Renewal of the still-current enrollment must not erase the pending key.
    await original.auth.handleUnauthorized();
    expect((await replacement.credentials.readPairingAttempt())?.attemptId).toBe(staged?.attemptId);
    const restarted = make('replacement');
    const promoted = await restarted.auth.pair('pairing-code', { replaceOtherStore: true });
    expect(promoted.devicePublicKey).toBe(attemptedKey);
    expect(promoted.deviceId).not.toBe(prior.deviceId);
    expect((await original.credentials.read())?.deviceId).toBe(promoted.deviceId);
    expect(await restarted.credentials.readPairingAttempt()).toBeUndefined();
  });
});

describe.each(['OS entry', 'injected backend'] as const)('registration fence (#2045, %s)', (backend) => {
  const productId = 'fence-test';
  let server: TestServer;
  let root: string;
  let value: string | undefined;
  let injected: InMemoryDeviceCredentialBackend;
  const auths: AuthManager[] = [];
  beforeEach(async () => {
    server = await TestServer.start();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-fence-'));
    value = undefined;
    injected = new InMemoryDeviceCredentialBackend();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(auths.splice(0).map(auth => auth.stop()));
    await server.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  const run: DeviceCommandRunner = async (_executable, args, stdin) => {
    if (args[0] === 'lookup') return { exitCode: value === undefined ? 1 : 0, stdout: value ?? '', stderr: '' };
    if (args[0] === 'clear') value = undefined;
    else value = stdin;
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  function make(name: string) {
    const storeDir = path.join(root, name);
    const credentials = backend === 'injected backend' ? injected
      : new DeviceCredentialStore({ storeDir, productId, platform: 'linux', commandRunner: run });
    const store = new DeviceStore(productId, storeDir, credentials);
    const auth = new AuthManager({ serverUrl: server.url, store, machineId: async () => 'f'.repeat(64) });
    auths.push(auth);
    return { auth, credentials, store };
  }

  /** Answers `/byok/pair` from `script` while it lasts, then from the test server; records every request body. */
  function scriptPair(script: Array<(body: Record<string, unknown>) => Promise<Response> | Response>) {
    const nativeFetch = globalThis.fetch;
    const bodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal('fetch', (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/byok/pair')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        bodies.push(body);
        const next = script.shift();
        if (next !== undefined) return next(body);
      }
      return nativeFetch(input, init);
    }) as typeof fetch);
    return bodies;
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const conflict = (currentDeviceDigest: unknown) => json(409, { error: 'pairing superseded', code: 'pairing_superseded', currentDeviceDigest });

  it('fences with the slot\'s current device and adopts a typed 409 once, inside the same call', async () => {
    const { auth } = make('store');
    const first = await auth.pair('code-1');
    const adopted = await pairDeviceDigest({ tenantId: 'tenant-test', productId, deviceId: 'device-elsewhere' });
    const bodies = scriptPair([() => conflict(adopted)]);
    const second = await auth.pair('code-2');
    expect(bodies.map(body => body.expectedDeviceDigest)).toEqual([
      await pairDeviceDigest({ tenantId: first.tenantId, productId, deviceId: first.deviceId }),
      adopted,
    ]);
    // A re-pair of this store's own enrollment keeps its key and resends the same request otherwise.
    expect(new Set(bodies.map(body => body.devicePublicKey))).toEqual(new Set([first.devicePublicKey]));
    expect(second.devicePublicKey).toBe(first.devicePublicKey);
  });

  it('answers a second 409 with a retryable PairingBusyError, keeps the attempt, and resumes it with the same code', async () => {
    const { auth, credentials } = make('store');
    const bodies = scriptPair([() => conflict(null), () => conflict(null)]);
    const busy = await auth.pair('code-1').catch((error: unknown) => error);
    expect(busy).toBeInstanceOf(PairingBusyError);
    expect((busy as PairingBusyError).retryable).toBe(true);
    const staged = await credentials.readPairingAttempt();
    expect(staged).toBeDefined();
    const paired = await auth.pair('code-1');
    expect(bodies).toHaveLength(3);
    expect(bodies[2]).toEqual(bodies[0]);
    expect(paired.devicePublicKey).toBe(publicKeyOfPrivateKeyPem(staged!.devicePrivateKeyPem));
    await expect(credentials.readPairingAttempt()).resolves.toBeUndefined();
  });

  it('stages a fresh key for a new code', async () => {
    const { auth, credentials } = make('store');
    scriptPair([() => json(503, {}), () => json(503, {})]);
    await expect(auth.pair('code-1')).rejects.toThrow('pairing failed: HTTP 503');
    const first = await credentials.readPairingAttempt();
    await expect(auth.pair('code-2')).rejects.toThrow('pairing failed: HTTP 503');
    const second = await credentials.readPairingAttempt();
    expect(second?.attemptId).not.toBe(first?.attemptId);
    expect(second?.devicePrivateKeyPem).not.toBe(first?.devicePrivateKeyPem);
  });

  it.each(['conflict', 'success'] as const)('neither resends nor persists once another pairing replaced its attempt (%s)', async (answer) => {
    const { auth, credentials } = make('store');
    const other = make('other');
    let otherDeviceId: string | undefined;
    const bodies = scriptPair([async () => {
      // Another store takes the slot while this request is in flight.
      otherDeviceId = (await other.auth.pair('code-other', { replaceOtherStore: true })).deviceId;
      return answer === 'conflict' ? conflict(null) : json(200, { deviceId: 'device-late', tenantId: 'tenant-test', accessToken: 'late', expiresIn: 3600 });
    }]);
    await expect(auth.pair('code-1')).rejects.toBeInstanceOf(PairingSupersededError);
    expect(bodies.filter(body => body.pairingCode === 'code-1')).toHaveLength(1);
    expect((await credentials.read())?.deviceId).toBe(otherDeviceId);
  });

  it.each([
    { status: 401, body: { error: 'invalid pairing code', code: 'pairing_code_invalid' }, expected: 'typed' },
    { status: 401, body: { error: 'secret-reflected-body' }, expected: 'pairing failed: HTTP 401' },
    { status: 409, body: { error: 'secret-reflected-body', code: 'pairing_superseded' }, expected: 'pairing failed: HTTP 409' },
    { status: 200, body: 'secret-reflected-body', expected: 'pairing failed: the server response does not match the protocol schema' },
  ])('maps a $status answer to a fixed error and keeps the attempt (%#)', async ({ status, body, expected }) => {
    const { auth, credentials } = make('store');
    scriptPair([() => typeof body === 'string' ? new Response(body, { status }) : json(status, body)]);
    const failure = await auth.pair('code-1').catch((caught: unknown) => caught) as Error;
    if (expected === 'typed') expect(failure).toBeInstanceOf(PairingCodeRejectedError);
    else expect(failure.message).toBe(expected);
    expect(String(failure.cause ?? '')).not.toContain('secret');
    expect(failure.message).not.toContain('secret');
    await expect(credentials.readPairingAttempt()).resolves.toBeDefined();
  });

  it('holds the enrollment gate only around local steps, never across the request', async () => {
    const { auth } = make('store');
    scriptPair([async (body) => {
      const gate = await acquireEnrollmentGate(productId);
      await gate.release();
      return conflict(body.expectedDeviceDigest);
    }]);
    await expect(auth.pair('code-1')).resolves.toBeDefined();
  });

  it('keeps the access token in memory only and exchanges one after a restart', async () => {
    const { auth, credentials } = make('store');
    await auth.pair('code-1');
    const token = await auth.getValidAccessToken();
    expect(Object.keys((await credentials.read())!).sort()).toEqual(['deviceId', 'devicePrivateKeyPem', 'devicePublicKey', 'tenantId']);
    if (backend === 'OS entry') expect(Buffer.from(value!.slice('byok-device-credential-v2:'.length), 'base64').toString()).not.toContain(token);
    const restarted = make('store');
    await restarted.auth.loadExisting();
    const exchanges = server.httpRequests.length;
    await expect(restarted.auth.getValidAccessToken()).resolves.toEqual(expect.any(String));
    expect(server.httpRequests.slice(exchanges).map((request) => request.pathname)).toEqual(['/byok/challenge', '/byok/token']);
  });

  // 33 code points pass a code-point bound of 64; they are 66 UTF-16 code units.
  it.each(['pair', 'promote', 'replace-other-store', 'token re-acquire'] as const)('writes nothing when a %s fails validation', async (operation) => {
    const { auth } = make('store');
    const other = make('other');
    if (operation !== 'pair') await auth.pair('code-1');
    const files = () => Promise.all(['store', 'other'].map(name => fs.readFile(path.join(root, name, 'device.json'), 'utf8').catch(() => undefined)));
    const entry = async () => backend === 'OS entry' ? value : JSON.stringify([await injected.read(), await injected.readPairingAttempt()]);
    const before = await files();
    // A pairing stages its attempt before sending; nothing may be written after the answer.
    let sent = await entry();
    scriptPair([async () => {
      sent = await entry();
      return json(200, { deviceId: '\u{1F600}'.repeat(33), tenantId: 'tenant-test', accessToken: 'paired', expiresIn: 3600 });
    }]);
    const failure = await (operation === 'token re-acquire' ? auth.handleUnauthorized()
      : (operation === 'replace-other-store' ? other : { auth }).auth.pair('code-2', { replaceOtherStore: operation === 'replace-other-store' }))
      .catch((error: unknown) => error);
    expect(await files()).toEqual(before);
    expect(await entry()).toBe(sent);
    if (operation !== 'token re-acquire') expect(failure).toBeInstanceOf(AuthResponseInvalidError);
  });

  it.each([
    { field: 'deviceName', options: { deviceName: 'h'.repeat(65) } },
    { field: 'deviceName', options: { deviceName: '' } },
    { field: 'deviceName', options: { deviceName: 'name\u0007' } },
    { field: 'machineId', options: { machineId: async () => 'not-a-digest' } },
  ])('refuses an out-of-bound $field before staging or sending (%#)', async ({ field, options }) => {
    const storeDir = path.join(root, 'bounded');
    const credentials = backend === 'injected backend' ? injected
      : new DeviceCredentialStore({ storeDir, productId, platform: 'linux', commandRunner: run });
    const auth = new AuthManager({ serverUrl: server.url, store: new DeviceStore(productId, storeDir, credentials), ...options });
    auths.push(auth);
    const bodies = scriptPair([]);
    const failure = await auth.pair('code-1').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PairingInputInvalidError);
    expect((failure as PairingInputInvalidError).field).toBe(field);
    expect(bodies).toHaveLength(0);
    await expect(credentials.readPairingAttempt()).resolves.toBeUndefined();
  });

  it.runIf(backend === 'OS entry')('deletes a wire v6 entry unread: daemon start reports re-pair, and a pairing pairs as a first pairing', async () => {
    const { auth, store } = make('store');
    await store.save({ deviceId: 'device-v6', tenantId: 'tenant-test', devicePublicKey: 'v6-public-key' });
    value = 'byok-device-credential-v1:not-decoded';
    await expect(auth.loadExisting()).rejects.toBeInstanceOf(DeviceRecordRePairRequiredError);
    expect(value).toBeUndefined();
    value = 'byok-device-credential-v1:not-decoded';
    const bodies = scriptPair([]);
    await auth.pair('code-1');
    expect(bodies[0]?.expectedDeviceDigest).toBeNull();
    expect(value?.startsWith('byok-device-credential-v2:')).toBe(true);
  });
});
