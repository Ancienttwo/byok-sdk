import { generateKeyPairSync, sign } from 'node:crypto';
import {
  DEVICE_ASSERTION_SCHEMA_ID,
  InMemoryDeviceAssertionReplayAuthority,
  TASK_ASSERTION_SCHEMA_ID,
  createMutableClock,
  deviceAssertionSigningInput,
  taskAssertionSigningInput,
  tenantId,
  type DeviceAssertionClaims,
  type DeviceAssertionReplayAuthority,
  type TaskAssertionClaims,
} from '@byok-sdk/core';
import { HOST_MCP_TASK_CONTEXT_CAPABILITY } from '@byok-sdk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { authenticateHostedDeviceAssertion, authenticateHostedTaskAssertion } from '../auth/device-assertion';
import { CLOUD_CAPABILITIES, CapabilitiesResponseSchema, declares, fullCapabilityDeclaration } from '../capabilities';
import { createWebCrypto } from '../crypto/web-crypto';
import { InMemoryDeviceDirectory } from '../stores/in-memory/device-directory';

const TENANT = tenantId('tenant-a');
const ISSUER = 'https://api.example.com';
const NOW = '2026-08-12T04:45:01.000Z';

describe('hosted device assertion authentication', () => {
  const keys = generateKeyPairSync('ed25519');
  const publicJwk = keys.publicKey.export({ format: 'jwk' });
  if (publicJwk.x === undefined) throw new Error('Ed25519 JWK has no x');
  const crypto = createWebCrypto();
  const clock = createMutableClock(new Date(NOW));
  let devices: InMemoryDeviceDirectory;

  beforeEach(async () => {
    clock.set(new Date(NOW));
    devices = new InMemoryDeviceDirectory();
    await devices.register(TENANT, {
      productId: 'product-a',
      deviceId: 'device-a',
      deviceName: 'connector host',
      devicePublicKey: publicJwk.x!,
      proofKeyId: 'identity',
      proofKeyEpoch: 0,
    });
  });

  function envelope(overrides: Partial<DeviceAssertionClaims> = {}) {
    const claims: DeviceAssertionClaims = {
      version: 1,
      issuer: ISSUER,
      productId: 'product-a',
      deviceId: 'device-a',
      audience: 'connector-binding',
      jti: 'AAAAAAAAAAAAAAAAAAAAAA',
      issuedAt: '2026-08-12T04:45:00.000Z',
      expiresAt: '2026-08-12T04:47:00.000Z',
      ...overrides,
    };
    return {
      schema: DEVICE_ASSERTION_SCHEMA_ID,
      algorithm: 'ed25519' as const,
      protected: claims,
      signature: sign(null, deviceAssertionSigningInput(claims), keys.privateKey).toString('base64url'),
    };
  }

  function authenticate(input: unknown, replay = new InMemoryDeviceAssertionReplayAuthority()) {
    return authenticateHostedDeviceAssertion(input, {
      devices,
      crypto,
      replay,
      clock,
      expected: {
        issuer: ISSUER,
        productId: 'product-a',
        audience: 'connector-binding',
      },
    });
  }

  it('adapts the current directory row and burns the assertion before returning success', async () => {
    const assertion = envelope();
    const replay = new InMemoryDeviceAssertionReplayAuthority();
    await expect(authenticate(assertion, replay)).resolves.toMatchObject({
      device: {
        kind: 'device',
        tenantId: TENANT,
        productId: 'product-a',
        deviceId: 'device-a',
      },
    });
    await expect(authenticate(assertion, replay)).resolves.toBeUndefined();
  });

  it('rejects revoked devices and binding mismatches without minting host state', async () => {
    const assertion = envelope();
    await devices.revoke(TENANT, 'device-a');
    await expect(authenticate(assertion)).resolves.toBeUndefined();

    devices = new InMemoryDeviceDirectory();
    await devices.register(TENANT, {
      productId: 'product-b',
      deviceId: 'device-a',
      deviceName: 'wrong product',
      devicePublicKey: publicJwk.x!,
      proofKeyId: 'identity',
      proofKeyEpoch: 0,
    });
    await expect(authenticate(assertion)).resolves.toBeUndefined();
  });

  it('never calls the connector binding side effect when authentication fails', async () => {
    let binds = 0;
    const authenticated = await authenticate(envelope({ audience: 'other-audience' }));
    if (authenticated !== undefined) binds += 1;
    expect(authenticated).toBeUndefined();
    expect(binds).toBe(0);
  });

  it('spends the assertion before a host-owned binding callback can fail', async () => {
    const assertion = envelope();
    const replay = new InMemoryDeviceAssertionReplayAuthority();
    const bind = async () => {
      throw new Error('provider login failed');
    };

    const authenticated = await authenticate(assertion, replay);
    expect(authenticated).toBeDefined();
    await expect(bind()).rejects.toThrow('provider login failed');
    await expect(authenticate(assertion, replay)).resolves.toBeUndefined();
  });
});

/**
 * Contract §8.1 / §8.2(2), hosted half of the task lane.
 *
 * The composition under test is the one a host actually wires: strict parse,
 * current device row (exists / not revoked / legal key), signature, exact
 * issuer/product/audience, time and TTL, and an atomic single-use `jti` — all
 * of it core's, composed here with the hosted directory/crypto/replay ports.
 *
 * The two properties this block exists to hold, both from §8.1's "the task lane
 * accepts nothing else and falls back to nothing": a device envelope presented
 * here authenticates as NOTHING, and a `jti` already burned in the device lane
 * is still spendable exactly once in the task lane (§8.2(2)'s `schema` segment).
 */
describe('hosted task assertion authentication', () => {
  const keys = generateKeyPairSync('ed25519');
  const publicJwk = keys.publicKey.export({ format: 'jwk' });
  if (publicJwk.x === undefined) throw new Error('Ed25519 JWK has no x');
  const crypto = createWebCrypto();
  const clock = createMutableClock(new Date(NOW));
  let devices: InMemoryDeviceDirectory;

  beforeEach(async () => {
    clock.set(new Date(NOW));
    devices = new InMemoryDeviceDirectory();
    await devices.register(TENANT, {
      productId: 'product-a',
      deviceId: 'device-a',
      deviceName: 'connector host',
      devicePublicKey: publicJwk.x!,
      proofKeyId: 'identity',
      proofKeyEpoch: 0,
    });
  });

  const AGENT_REF = { agentId: 'salesko-agent', profileRevision: 'profile-rev-1' } as const;

  function taskClaims(overrides: Partial<TaskAssertionClaims> = {}): TaskAssertionClaims {
    return {
      version: 1,
      issuer: ISSUER,
      productId: 'product-a',
      deviceId: 'device-a',
      audience: 'connector-binding',
      jti: 'BBBBBBBBBBBBBBBBBBBBBB',
      issuedAt: '2026-08-12T04:45:00.000Z',
      expiresAt: '2026-08-12T04:47:00.000Z',
      taskId: 'task-1',
      agentRef: { ...AGENT_REF },
      toolsetId: 'salesko.read.v1',
      ...overrides,
    };
  }

  function taskEnvelope(overrides: Partial<TaskAssertionClaims> = {}) {
    const claims = taskClaims(overrides);
    return {
      schema: TASK_ASSERTION_SCHEMA_ID,
      algorithm: 'ed25519' as const,
      protected: claims,
      signature: sign(null, taskAssertionSigningInput(claims), keys.privateKey).toString('base64url'),
    };
  }

  /** The device envelope, signed for real, used only to prove it is refused here. */
  function deviceEnvelope(overrides: Partial<DeviceAssertionClaims> = {}) {
    const claims: DeviceAssertionClaims = {
      version: 1,
      issuer: ISSUER,
      productId: 'product-a',
      deviceId: 'device-a',
      audience: 'connector-binding',
      jti: 'CCCCCCCCCCCCCCCCCCCCCC',
      issuedAt: '2026-08-12T04:45:00.000Z',
      expiresAt: '2026-08-12T04:47:00.000Z',
      ...overrides,
    };
    return {
      schema: DEVICE_ASSERTION_SCHEMA_ID,
      algorithm: 'ed25519' as const,
      protected: claims,
      signature: sign(null, deviceAssertionSigningInput(claims), keys.privateKey).toString('base64url'),
    };
  }

  function deps(replay: DeviceAssertionReplayAuthority, expectedAudience = 'connector-binding') {
    return {
      devices,
      crypto,
      replay,
      clock,
      expected: { issuer: ISSUER, productId: 'product-a', audience: expectedAudience },
    };
  }

  it('returns the verified task binding and burns the jti under the task segment', async () => {
    const replay = new InMemoryDeviceAssertionReplayAuthority();
    const assertion = taskEnvelope();

    const authenticated = await authenticateHostedTaskAssertion(assertion, deps(replay));
    expect(authenticated).toEqual({
      lane: 'task',
      device: { kind: 'device', tenantId: TENANT, productId: 'product-a', deviceId: 'device-a' },
      issuer: ISSUER,
      audience: 'connector-binding',
      jti: 'BBBBBBBBBBBBBBBBBBBBBB',
      issuedAt: '2026-08-12T04:45:00.000Z',
      expiresAt: '2026-08-12T04:47:00.000Z',
      taskId: 'task-1',
      agentRef: AGENT_REF,
      toolsetId: 'salesko.read.v1',
    });
    // Consumed before success was returned, so a replay gets nothing.
    await expect(authenticateHostedTaskAssertion(assertion, deps(replay))).resolves.toBeUndefined();
  });

  it('refuses a device envelope outright — the task lane has no device fallback', async () => {
    const replay = new InMemoryDeviceAssertionReplayAuthority();
    const device = deviceEnvelope();

    await expect(authenticateHostedTaskAssertion(device, deps(replay))).resolves.toBeUndefined();
    // And it did not even spend the key: the device lane can still use it.
    await expect(authenticateHostedDeviceAssertion(device, deps(replay))).resolves.toMatchObject({
      lane: 'device',
    });
  });

  it('keeps the two lanes ledgers separate: the same jti spends once in each', async () => {
    const replay = new InMemoryDeviceAssertionReplayAuthority();
    const shared = 'DDDDDDDDDDDDDDDDDDDDDD';

    await expect(
      authenticateHostedDeviceAssertion(deviceEnvelope({ jti: shared }), deps(replay)),
    ).resolves.toBeDefined();
    // Device lane burned it; the task segment is a different key slot entirely.
    await expect(
      authenticateHostedTaskAssertion(taskEnvelope({ jti: shared }), deps(replay)),
    ).resolves.toBeDefined();
    // And neither lane can spend its own twice.
    await expect(
      authenticateHostedDeviceAssertion(deviceEnvelope({ jti: shared }), deps(replay)),
    ).resolves.toBeUndefined();
    await expect(
      authenticateHostedTaskAssertion(taskEnvelope({ jti: shared }), deps(replay)),
    ).resolves.toBeUndefined();
  });

  it('rejects rather than degrading when the replay store is unavailable', async () => {
    const broken: DeviceAssertionReplayAuthority = {
      consume: () => Promise.reject(new Error('replay store unavailable')),
    };
    await expect(authenticateHostedTaskAssertion(taskEnvelope(), deps(broken))).rejects.toThrow(
      'replay store unavailable',
    );
  });

  it('refuses an expected-binding mismatch and a revoked device', async () => {
    const replay = new InMemoryDeviceAssertionReplayAuthority();
    await expect(
      authenticateHostedTaskAssertion(taskEnvelope(), deps(replay, 'other-audience')),
    ).resolves.toBeUndefined();

    await devices.revoke(TENANT, 'device-a');
    await expect(authenticateHostedTaskAssertion(taskEnvelope(), deps(replay))).resolves.toBeUndefined();
  });
});

/**
 * Contract §8.1 / AC13 (R2-N19), deployment-level half of the capability gate.
 *
 * §8.2(1) — "capability 只有完整实现后宣告" — is why this is opt-in rather than
 * part of the default declaration: a deployment declares the task lane only
 * once its own host side actually verifies task assertions.
 */
describe('host-mcp-task-context deployment capability', () => {
  it('is the same literal name the device-level channel carries', () => {
    expect(CLOUD_CAPABILITIES.hostMcpTaskContext).toBe('host-mcp-task-context');
    expect(CLOUD_CAPABILITIES.hostMcpTaskContext).toBe(HOST_MCP_TASK_CONTEXT_CAPABILITY);
  });

  it('is withheld by default and declared only when a composition opts in', () => {
    expect(fullCapabilityDeclaration().capabilities).not.toContain(CLOUD_CAPABILITIES.hostMcpTaskContext);
    expect(declares(fullCapabilityDeclaration(), CLOUD_CAPABILITIES.hostMcpTaskContext)).toBe(false);

    const declared = fullCapabilityDeclaration(1, { includeHostMcpTaskContext: true });
    expect(declares(declared, CLOUD_CAPABILITIES.hostMcpTaskContext)).toBe(true);
    // Still a valid ADR-010 declaration on the wire.
    expect(CapabilitiesResponseSchema.safeParse(declared).success).toBe(true);
  });
});
