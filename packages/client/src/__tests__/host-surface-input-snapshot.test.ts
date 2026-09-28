import { generateKeyPairSync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import { PROVIDER_SECRET_SEALING_KEY_REGISTER_OPERATION } from '@byok-sdk/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createStoredDeviceProofSigner,
  DeviceProofSignerError,
  readDeviceEnrollmentIdentity,
  readDeviceEnrollmentStatus,
  retireInputPreparation,
  type CreateStoredDeviceProofSignerOptions,
  type DeviceProofRequest,
  type RetireInputPreparationInput,
  type RetireInputPreparationTarget,
} from '../index';
import { exportPrivateKeyPem } from '../daemon/device-keys';
import { DeviceStore } from '../daemon/store';
import { clearDeviceEnrollment, seedDeviceEnrollment } from './fixtures/device-enrollment';

/**
 * S4 acceptance round 1 (S4-F1 / S4-F2): every host-supplied options, identity,
 * request, target and input object is copied ONCE into inert plain data inside
 * the guarded region, and only that copy is validated and used. A getter,
 * setter, Proxy trap, symbol key or non-plain prototype can neither change the
 * value between check and use nor push its own error (or cause) past the
 * closed-code boundary.
 */

const PRODUCT = 'input-snapshot-product';
const TENANT = 'tenant-input-snapshot';
const ALLOWED = PROVIDER_SECRET_SEALING_KEY_REGISTER_OPERATION;
const OUTSIDE = 'probe.outside-list';
const MARKER = 'SYNTHETIC-DIAGNOSTIC-MARKER-7f3a';
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function pairedStore(): Promise<{ storeDir: string; identity: CreateStoredDeviceProofSignerOptions['identity'] }> {
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-input-snapshot-'));
  cleanups.push(() => fs.rm(storeDir, { recursive: true, force: true }));
  const keys = generateKeyPairSync('ed25519');
  const x = keys.publicKey.export({ format: 'jwk' }).x;
  if (x === undefined) throw new Error('test key has no public x coordinate');
  await seedDeviceEnrollment(new DeviceStore(storeDir, undefined, PRODUCT), {
    deviceId: 'device-snapshot',
    tenantId: TENANT,
    accessToken: 'secret-access-token',
    expiresAt: '2030-01-01T00:00:00.000Z',
    devicePrivateKeyPem: exportPrivateKeyPem(keys.privateKey),
    devicePublicKey: x,
  });
  return { storeDir, identity: { tenantId: TENANT, deviceId: 'device-snapshot', proofKeyId: 'identity', proofKeyEpoch: 0 } };
}

function markerError(): Error {
  return new Error(`getter failed ${MARKER}`, { cause: new Error(`cause ${MARKER}`) });
}

function plainRequest(): DeviceProofRequest {
  return {
    method: 'PUT',
    path: '/api/agent/devices/device-snapshot/provider-sealing-key',
    operation: ALLOWED,
    resource: 'provider-sealing-key',
    requestId: 'snapshot-1',
    body: new TextEncoder().encode('{"claim":1}'),
  };
}

/** Rejects with the closed error type, no cause and no marker anywhere; returns the code. */
async function closedSignerFailure(action: () => Promise<unknown> | unknown): Promise<string> {
  let caught: unknown;
  try {
    const value = await action();
    // A resolved envelope must never carry an operation outside the allowlist.
    const operation = (value as { protected?: { operation?: unknown } } | undefined)?.protected?.operation;
    throw new Error(`expected a refusal, got an envelope for ${String(operation)}`);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(DeviceProofSignerError);
  const error = caught as DeviceProofSignerError;
  expect(error.cause).toBeUndefined();
  expect(Object.hasOwn(error, 'cause')).toBe(false);
  expect(error.message).not.toContain(MARKER);
  expect(inspect(error, { depth: Infinity, showHidden: true })).not.toContain(MARKER);
  expect(JSON.stringify(error)).not.toContain(MARKER);
  return error.code;
}

/** A plain Error type with no cause and no marker anywhere. */
async function closedPlainFailure(action: () => Promise<unknown>, type: abstract new (...args: never[]) => Error): Promise<void> {
  const caught = await action().then(() => undefined, (error: unknown) => error);
  expect(caught).toBeInstanceOf(type);
  const error = caught as Error;
  expect(error.cause).toBeUndefined();
  expect(error.message).not.toContain(MARKER);
  expect(inspect(error, { depth: Infinity, showHidden: true })).not.toContain(MARKER);
}

/** A Proxy whose every trap records itself and throws a marker error. */
function hostileProxy(target: object, trapCalls: string[]): object {
  const trap = (name: string) => () => {
    trapCalls.push(name);
    throw markerError();
  };
  return new Proxy(target, {
    get: trap('get'),
    has: trap('has'),
    ownKeys: trap('ownKeys'),
    getOwnPropertyDescriptor: trap('getOwnPropertyDescriptor'),
    getPrototypeOf: trap('getPrototypeOf'),
    isExtensible: trap('isExtensible'),
  });
}

describe('host device-proof signer: request snapshot (S4-F1)', () => {
  it('never signs an operation outside the allowlist from a value-changing getter', async () => {
    const { storeDir, identity } = await pairedStore();
    const signer = createStoredDeviceProofSigner({ productId: PRODUCT, storeDir, identity, operations: [ALLOWED] });
    let reads = 0;
    const request = { ...plainRequest() } as Record<string, unknown>;
    Object.defineProperty(request, 'operation', {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads <= 2 ? ALLOWED : OUTSIDE;
      },
    });
    expect(await closedSignerFailure(() => signer.sign(request as unknown as DeviceProofRequest))).toBe('invalid_request');
  });

  it('refuses an accessor request before reading the enrollment', async () => {
    const { storeDir, identity } = await pairedStore();
    const signer = createStoredDeviceProofSigner({ productId: PRODUCT, storeDir, identity, operations: [ALLOWED] });
    await clearDeviceEnrollment(new DeviceStore(storeDir, undefined, PRODUCT));
    const request = { ...plainRequest() } as Record<string, unknown>;
    Object.defineProperty(request, 'operation', { enumerable: true, get: () => ALLOWED });
    // `unpaired` would mean the enrollment had been consulted.
    expect(await closedSignerFailure(() => signer.sign(request as unknown as DeviceProofRequest))).toBe('invalid_request');
  });

  it('snapshots the body once: later mutation of the caller bytes cannot change what is signed', async () => {
    const { storeDir, identity } = await pairedStore();
    const signer = createStoredDeviceProofSigner({ productId: PRODUCT, storeDir, identity, operations: [ALLOWED] });
    const request = plainRequest();
    const expected = await signer.sign(request);
    const pending = signer.sign(request);
    request.body.fill(0x41);
    const envelope = await pending;
    expect(envelope.protected.bodySha256).toBe(expected.protected.bodySha256);
  });

  it('ignores an own accessor shadowing the body buffer and refuses non-plain byte views', async () => {
    const { storeDir, identity } = await pairedStore();
    const signer = createStoredDeviceProofSigner({ productId: PRODUCT, storeDir, identity, operations: [ALLOWED] });
    const reference = await signer.sign(plainRequest());

    const shadowed = plainRequest();
    Object.defineProperty(shadowed.body, 'buffer', { get: () => { throw markerError(); } });
    Object.defineProperty(shadowed.body, 'byteLength', { get: () => { throw markerError(); } });
    const envelope = await signer.sign(shadowed);
    expect(envelope.protected.bodySha256).toBe(reference.protected.bodySha256);
    expect(envelope.protected.bodySize).toBe(reference.protected.bodySize);

    class HostileBytes extends Uint8Array {}
    expect(await closedSignerFailure(() => signer.sign({ ...plainRequest(), body: new HostileBytes(3) })))
      .toBe('invalid_request');
    expect(await closedSignerFailure(() => signer.sign({ ...plainRequest(), body: new Uint16Array(2) as unknown as Uint8Array })))
      .toBe('invalid_request');
  });
});

describe('host device-proof signer: closed codes for hostile inputs (S4-F2)', () => {
  it('maps a throwing request getter to invalid_request with no cause', async () => {
    const { storeDir, identity } = await pairedStore();
    const signer = createStoredDeviceProofSigner({ productId: PRODUCT, storeDir, identity, operations: [ALLOWED] });
    for (const key of ['operation', 'method', 'body', 'issuedAt'] as const) {
      const request = { ...plainRequest() } as Record<string, unknown>;
      Object.defineProperty(request, key, { enumerable: true, get: () => { throw markerError(); } });
      expect(await closedSignerFailure(() => signer.sign(request as unknown as DeviceProofRequest))).toBe('invalid_request');
    }
  });

  it('maps Proxy requests (hostile, revoked and benign) to invalid_request without running a trap', async () => {
    const { storeDir, identity } = await pairedStore();
    const signer = createStoredDeviceProofSigner({ productId: PRODUCT, storeDir, identity, operations: [ALLOWED] });
    const trapCalls: string[] = [];
    const revocable = Proxy.revocable(plainRequest(), {});
    revocable.revoke();
    for (const request of [hostileProxy(plainRequest(), trapCalls), revocable.proxy, new Proxy(plainRequest(), {})]) {
      expect(await closedSignerFailure(() => signer.sign(request as DeviceProofRequest))).toBe('invalid_request');
    }
    const bodyProxy = { ...plainRequest(), body: hostileProxy(new Uint8Array(3), trapCalls) };
    expect(await closedSignerFailure(() => signer.sign(bodyProxy as unknown as DeviceProofRequest))).toBe('invalid_request');
    expect(trapCalls).toEqual([]);
  });

  it('refuses symbol keys and non-plain prototypes on the request', async () => {
    const { storeDir, identity } = await pairedStore();
    const signer = createStoredDeviceProofSigner({ productId: PRODUCT, storeDir, identity, operations: [ALLOWED] });
    const withSymbol = { ...plainRequest(), [Symbol('extra')]: 1 };
    const inherited = Object.assign(Object.create({ operation: ALLOWED }) as object, { ...plainRequest(), operation: undefined });
    class RequestLike { constructor(readonly value: DeviceProofRequest) { Object.assign(this, value); } }
    for (const request of [withSymbol, inherited, new RequestLike(plainRequest())]) {
      expect(await closedSignerFailure(() => signer.sign(request as unknown as DeviceProofRequest))).toBe('invalid_request');
    }
  });

  it('maps throwing getters and Proxies on options, identity and operations to invalid_options with no cause', async () => {
    const { storeDir, identity } = await pairedStore();
    const trapCalls: string[] = [];
    const base = (): Record<string, unknown> => ({ productId: PRODUCT, storeDir, identity: { ...identity }, operations: [ALLOWED] });
    const cases: unknown[] = [];
    for (const key of ['productId', 'storeDir', 'identity', 'operations', 'clock']) {
      const options = base();
      Object.defineProperty(options, key, { enumerable: true, get: () => { throw markerError(); } });
      cases.push(options);
    }
    const identityGetter = base();
    Object.defineProperty(identityGetter.identity as object, 'tenantId', { enumerable: true, get: () => { throw markerError(); } });
    cases.push(identityGetter);
    const operationGetter = base();
    Object.defineProperty(operationGetter.operations as object, '0', { enumerable: true, get: () => { throw markerError(); } });
    cases.push(operationGetter);
    cases.push(hostileProxy(base(), trapCalls));
    cases.push({ ...base(), identity: hostileProxy({ ...identity }, trapCalls) });
    cases.push({ ...base(), operations: hostileProxy([ALLOWED], trapCalls) });
    for (const options of cases) {
      expect(await closedSignerFailure(() => createStoredDeviceProofSigner(options as CreateStoredDeviceProofSignerOptions)))
        .toBe('invalid_options');
    }
    expect(trapCalls).toEqual([]);
  });

  it('snapshots the allowlist at creation: later mutation of the caller array changes nothing', async () => {
    const { storeDir, identity } = await pairedStore();
    const operations: string[] = [ALLOWED];
    const signer = createStoredDeviceProofSigner({ productId: PRODUCT, storeDir, identity, operations });
    operations.push(OUTSIDE);
    expect(await closedSignerFailure(() => signer.sign({ ...plainRequest(), operation: OUTSIDE }))).toBe('operation_not_allowed');
    expect(signer.operations).toEqual([ALLOWED]);
  });

  it('maps a throwing or non-Date clock to a closed code with no cause', async () => {
    const { storeDir, identity } = await pairedStore();
    const throwing = createStoredDeviceProofSigner({
      productId: PRODUCT, storeDir, identity, operations: [ALLOWED], clock: () => { throw markerError(); },
    });
    expect(await closedSignerFailure(() => throwing.sign(plainRequest()))).toBe('invalid_options');
    const notDate = createStoredDeviceProofSigner({
      productId: PRODUCT, storeDir, identity, operations: [ALLOWED],
      clock: () => ({ toISOString: () => { throw markerError(); } }) as unknown as Date,
    });
    expect(await closedSignerFailure(() => notDate.sign(plainRequest()))).toBe('invalid_options');
  });
});

describe('host device-proof signer: preserved closed paths', () => {
  it('still maps a malformed stored key to signing_failed with no cause', async () => {
    const { storeDir, identity } = await pairedStore();
    const store = new DeviceStore(storeDir, undefined, PRODUCT);
    const record = await store.credentials.read();
    if (record === undefined) throw new Error('seeded enrollment is missing');
    await store.credentials.replace({ ...record, devicePrivateKeyPem: `not a pem ${MARKER}` });
    const signer = createStoredDeviceProofSigner({ productId: PRODUCT, storeDir, identity, operations: [ALLOWED] });
    expect(await closedSignerFailure(() => signer.sign(plainRequest()))).toBe('signing_failed');
  });
});

describe('enrollment reads and retirement: option snapshot', () => {
  it('reads productId/storeDir once as plain data and refuses accessors and Proxies without a cause', async () => {
    const { storeDir } = await pairedStore();
    const trapCalls: string[] = [];
    const getter = { storeDir } as Record<string, unknown>;
    Object.defineProperty(getter, 'productId', { enumerable: true, get: () => { throw markerError(); } });
    let reads = 0;
    const flipping = { productId: PRODUCT } as Record<string, unknown>;
    Object.defineProperty(flipping, 'storeDir', { enumerable: true, get: () => (reads++ === 0 ? storeDir : '/elsewhere') });
    for (const options of [getter, flipping, hostileProxy({ productId: PRODUCT, storeDir }, trapCalls)]) {
      await closedPlainFailure(() => readDeviceEnrollmentIdentity(options as never), TypeError);
      await closedPlainFailure(() => readDeviceEnrollmentStatus(options as never), TypeError);
    }
    expect(trapCalls).toEqual([]);
    // Unrelated host fields (for example a whole daemon config) are neither read nor refused.
    const config = { productId: PRODUCT, storeDir, adapters: [new (class Adapter {})()] };
    Object.defineProperty(config, 'unrelated', { enumerable: true, get: () => { throw markerError(); } });
    expect(await readDeviceEnrollmentIdentity(config)).toMatchObject({ state: 'paired', deviceId: 'device-snapshot' });
  });

  it('retirement refuses accessor and Proxy targets and inputs with a TypeError and no cause', async () => {
    const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'byok-input-snapshot-retire-'));
    cleanups.push(() => fs.rm(storeDir, { recursive: true, force: true }));
    const trapCalls: string[] = [];
    const getterTarget = { storeDir } as Record<string, unknown>;
    Object.defineProperty(getterTarget, 'productId', { enumerable: true, get: () => { throw markerError(); } });
    for (const target of [getterTarget, hostileProxy({ productId: PRODUCT, storeDir }, trapCalls)]) {
      await closedPlainFailure(
        () => retireInputPreparation(target as unknown as RetireInputPreparationTarget, { mode: 'preview' }),
        TypeError,
      );
    }
    let reads = 0;
    const flippingMode = {} as Record<string, unknown>;
    Object.defineProperty(flippingMode, 'mode', { enumerable: true, get: () => (reads++ === 0 ? 'preview' : 'execute') });
    const confirmedGetter = { mode: 'execute' } as Record<string, unknown>;
    Object.defineProperty(confirmedGetter, 'confirmed', { enumerable: true, get: () => { throw markerError(); } });
    for (const input of [flippingMode, confirmedGetter, hostileProxy({ mode: 'preview' }, trapCalls)]) {
      await closedPlainFailure(
        () => retireInputPreparation({ productId: PRODUCT, storeDir }, input as unknown as RetireInputPreparationInput),
        TypeError,
      );
    }
    expect(trapCalls).toEqual([]);
    await expect(fs.readdir(storeDir)).resolves.toEqual([]);
  });
});
