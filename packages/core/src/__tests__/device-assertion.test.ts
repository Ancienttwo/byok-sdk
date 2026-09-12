/**
 * Device assertion canonicalization, domain separation, and verification.
 *
 * The falsifier this whole design rests on is asserted first, in
 * `domain separation` below: the three domain prefixes this ONE Ed25519 device
 * key signs under — `byok-nonce-v1\n` (challenge/token renewal),
 * `byok-device-proof-v1\n` (request-bound proof), and
 * `byok-device-assertion-v1\n` (this file) — must be pairwise distinct AND
 * pairwise non-prefix, and a signature made under one must not verify under
 * another. If any one were a prefix of another, a signature over the longer
 * domain's bytes could be reinterpreted under the shorter one, and the domain
 * design would be wrong rather than merely untested.
 *
 * The golden fixture (`golden/device-assertion-v1.canonical.json`) plays the
 * same role it does for the device proof: regenerate deliberately with
 * `BYOK_CORE_UPDATE_GOLDEN=1 bun run --filter @byok-sdk/core test`, and treat any
 * resulting diff as a breaking change to the signing format.
 */
import { createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEVICE_ASSERTION_AUDIENCE_MAX_BYTES,
  DEVICE_ASSERTION_DEFAULT_TTL_MS,
  DEVICE_ASSERTION_DOMAIN_PREFIX,
  DEVICE_ASSERTION_MAX_TTL_MS,
  DEVICE_ASSERTION_SCHEMA_ID,
  DeviceAssertionClaimsSchema,
  TASK_ASSERTION_DOMAIN_PREFIX,
  TASK_ASSERTION_SCHEMA_ID,
  TaskAssertionClaimsSchema,
  authenticateDeviceAssertion,
  authenticateTaskAssertion,
  deviceAssertionCanonicalClaims,
  deviceAssertionCanonicalJson,
  deviceAssertionSigningInput,
  parseDeviceAssertionEnvelope,
  parseTaskAssertionEnvelope,
  taskAssertionCanonicalClaims,
  taskAssertionCanonicalJson,
  taskAssertionSigningInput,
  verifyDeviceAssertion,
  verifyTaskAssertion,
  type DeviceAssertionClaims,
  type DeviceAssertionEnvelopeV1,
  type DeviceAssertionReplayAuthority,
  type DeviceAssertionVerifier,
  type TaskAssertionClaims,
  type TaskAssertionEnvelopeV1,
} from '../device-assertion';
import { DEVICE_PROOF_DOMAIN_PREFIX, deviceProofSigningInput, DeviceProofProtectedClaimsSchema } from '../attestation';
import { isCoreError } from '../errors';
import { InMemoryDeviceAssertionReplayAuthority } from '../in-memory/device-assertion-replay';
import { tenantId } from '../tenant';

const GOLDEN_URL = new URL('./golden/device-assertion-v1.canonical.json', import.meta.url);

/**
 * Only the two domain prefixes core actually OWNS are cross-checked here
 * (`byok-device-proof-v1\n` and `byok-device-assertion-v1\n`), using the
 * exported production constants — no restated literal.
 *
 * The third domain, `byok-nonce-v1\n`, is a WIRE constant that lives in
 * `@byok-sdk/client`'s `device-keys.ts` (and `packages/server/src/auth.ts`) and
 * is deliberately not shared through a package. Core cannot import it without
 * creating an edge that must not exist (`constraints.test.ts` forbids core
 * from importing any sibling `@byok-sdk/*` workspace package, tests included),
 * so restating the literal
 * here would only test a copy — production drift in the real nonce constant
 * would sail past it. The authoritative three-way (nonce-inclusive) falsifier
 * therefore lives in the CLIENT suite (`device-assertion-broker.test.ts`),
 * which imports the real `NONCE_SIGNING_DOMAIN` and turns red on drift.
 */

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseClaims(input: unknown): DeviceAssertionClaims {
  return DeviceAssertionClaimsSchema.parse(input);
}

// ---------------------------------------------------------------------------
// Golden
// ---------------------------------------------------------------------------

/** The claim sets the golden pins. Extending this list is an additive change. */
const GOLDEN_INPUTS: readonly { readonly name: string; readonly claims: unknown }[] = [
  {
    name: 'minimal ascii claim set',
    claims: {
      version: 1,
      issuer: 'https://api.example.com',
      productId: 'product-a',
      deviceId: 'device-1',
      audience: 'salesko-api',
      jti: 'AAAAAAAAAAAAAAAAAAAAAA',
      issuedAt: '2026-08-12T04:45:00.000Z',
      expiresAt: '2026-08-12T04:47:00.000Z',
    },
  },
  {
    name: 'non-ascii audience and product, non-default port issuer',
    claims: {
      version: 1,
      issuer: 'https://staging.example.com:8443',
      productId: '产品-b',
      deviceId: 'device-2',
      audience: '受众/"quoted"\u0000',
      jti: 'ZmFrZS1qdGktZm9yLWdvbA',
      issuedAt: '2026-08-12T04:45:00.000Z',
      expiresAt: '2026-08-12T04:50:00.000Z',
    },
  },
];

interface GoldenCase {
  readonly name: string;
  readonly claims: unknown;
  readonly canonicalJson: string;
  readonly signingInputUtf8: string;
  readonly signingInputHex: string;
}

interface GoldenFile {
  readonly schema: string;
  readonly domainPrefix: string;
  readonly note: string;
  readonly cases: readonly GoldenCase[];
}

function buildGolden(): GoldenFile {
  return {
    schema: DEVICE_ASSERTION_SCHEMA_ID,
    domainPrefix: DEVICE_ASSERTION_DOMAIN_PREFIX,
    note: 'Canonical signing bytes for byok-device-assertion-v1. Regenerate with BYOK_CORE_UPDATE_GOLDEN=1 bun run --filter @byok-sdk/core test, and treat any diff as a breaking change to the signature format.',
    cases: GOLDEN_INPUTS.map((input) => {
      const claims = parseClaims(input.claims);
      return {
        name: input.name,
        claims: input.claims,
        canonicalJson: deviceAssertionCanonicalJson(claims),
        signingInputUtf8: DEVICE_ASSERTION_DOMAIN_PREFIX + deviceAssertionCanonicalJson(claims),
        signingInputHex: toHex(deviceAssertionSigningInput(claims)),
      };
    }),
  };
}

if (process.env['BYOK_CORE_UPDATE_GOLDEN'] === '1') {
  writeFileSync(GOLDEN_URL, `${JSON.stringify(buildGolden(), null, 2)}\n`, 'utf8');
}

const golden = JSON.parse(readFileSync(GOLDEN_URL, 'utf8')) as GoldenFile;

describe('device assertion golden', () => {
  it('covers every pinned claim set', () => {
    expect(golden.cases.map((entry) => entry.name)).toEqual(GOLDEN_INPUTS.map((input) => input.name));
    expect(golden.domainPrefix).toBe('byok-device-assertion-v1\n');
    expect(golden.schema).toBe('byok-device-assertion-v1');
  });

  for (const [index, input] of GOLDEN_INPUTS.entries()) {
    it(`reproduces the frozen bytes: ${input.name}`, () => {
      const expected = golden.cases[index]!;
      const claims = parseClaims(input.claims);

      expect(deviceAssertionCanonicalJson(claims)).toBe(expected.canonicalJson);
      expect(toHex(deviceAssertionSigningInput(claims))).toBe(expected.signingInputHex);
      expect(expected.signingInputUtf8.startsWith(DEVICE_ASSERTION_DOMAIN_PREFIX)).toBe(true);
      expect(expected.signingInputUtf8).toBe(DEVICE_ASSERTION_DOMAIN_PREFIX + expected.canonicalJson);
    });
  }

  it('is invariant under claim key insertion order', () => {
    for (const input of GOLDEN_INPUTS) {
      const entries = Object.entries(input.claims as Record<string, unknown>);
      const reversed = Object.fromEntries([...entries].reverse());
      const rotated = Object.fromEntries([...entries.slice(3), ...entries.slice(0, 3)]);
      const baseline = toHex(deviceAssertionSigningInput(parseClaims(input.claims)));
      expect(toHex(deviceAssertionSigningInput(parseClaims(reversed)))).toBe(baseline);
      expect(toHex(deviceAssertionSigningInput(parseClaims(rotated)))).toBe(baseline);
    }
  });

  it('projects exactly the eight claims, all of them required', () => {
    const claims = parseClaims(GOLDEN_INPUTS[0]!.claims);
    expect(Object.keys(deviceAssertionCanonicalClaims(claims)).sort()).toEqual([
      'audience',
      'deviceId',
      'expiresAt',
      'issuedAt',
      'issuer',
      'jti',
      'productId',
      'version',
    ]);
  });

  it('carries no devicePublicKey, no caller identity, and no keyId', () => {
    const claims = parseClaims(GOLDEN_INPUTS[0]!.claims);
    const canonical = deviceAssertionCanonicalJson(claims);
    for (const forbidden of ['devicePublicKey', 'keyId', 'callerPid', 'callerUid', 'caller']) {
      expect(canonical).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// Falsifier: domain separation
// ---------------------------------------------------------------------------

describe('domain separation (falsifier)', () => {
  const DOMAINS: readonly (readonly [string, string])[] = [
    ['device proof', DEVICE_PROOF_DOMAIN_PREFIX],
    ['device assertion', DEVICE_ASSERTION_DOMAIN_PREFIX],
    ['task assertion', TASK_ASSERTION_DOMAIN_PREFIX],
  ];

  it('keeps the three core-owned prefixes distinct and non-prefix', () => {
    for (const [leftName, left] of DOMAINS) {
      for (const [rightName, right] of DOMAINS) {
        if (leftName === rightName) continue;
        expect(left).not.toBe(right);
        expect(
          left.startsWith(right),
          `${leftName} prefix must not start with the ${rightName} prefix`,
        ).toBe(false);
        expect(
          right.startsWith(left),
          `${rightName} prefix must not start with the ${leftName} prefix`,
        ).toBe(false);
      }
    }
  });

  it('ends every domain prefix with a newline, so no prefix can extend into another', () => {
    // The structural reason the pairwise check above can never start failing by
    // accident: a terminating `\n` that appears nowhere else in any prefix
    // means one prefix can only be a prefix of another by being equal to it.
    for (const [, domain] of DOMAINS) {
      expect(domain.endsWith('\n')).toBe(true);
      expect(domain.slice(0, -1)).not.toContain('\n');
    }
  });

  it('rejects a device-proof signature presented as a device assertion, and vice versa', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const devicePublicKey = (publicKey.export({ format: 'jwk' }) as { x: string }).x;
    const claims = parseClaims(GOLDEN_INPUTS[0]!.claims);

    const proofSignature = sign(null, deviceProofSigningInput(PROOF_CLAIMS), privateKey).toString('base64url');
    await expect(
      verifyDeviceAssertion(
        { schema: DEVICE_ASSERTION_SCHEMA_ID, algorithm: 'ed25519', protected: claims, signature: proofSignature },
        { verifier: nodeVerifier, lookupDevice: () => ({ publicKeyJwkX: devicePublicKey, revoked: false }), now: new Date(claims.issuedAt) },
      ),
    ).resolves.toBeUndefined();

    const assertionSignature = Buffer.from(sign(null, deviceAssertionSigningInput(claims), privateKey));
    expect(verify(null, deviceProofSigningInput(PROOF_CLAIMS), publicKey, assertionSignature)).toBe(false);
  });
});

const PROOF_CLAIMS = DeviceProofProtectedClaimsSchema.parse({
  version: 1,
  tenantId: 'tenant-a',
  productId: 'product-a',
  deviceId: 'device-1',
  keyId: 'key-1',
  keyEpoch: 0,
  requestId: 'req-1',
  operation: 'truth.write',
  resource: 'task/task-1',
  method: 'PUT',
  path: '/byok/records/task.terminal/task-1',
  bodySha256: `sha256:${'ab'.repeat(32)}`,
  bodySize: 1024,
  issuedAt: '2026-08-12T04:45:00.000Z',
});

// ---------------------------------------------------------------------------
// Envelope parsing
// ---------------------------------------------------------------------------

const NODE_VERIFIER_ALGORITHM = 'ed25519';

/** The real Ed25519 verification core deliberately does not contain. */
const nodeVerifier: DeviceAssertionVerifier = {
  verify: ({ algorithm, publicKey, signature, signingInput }) => {
    if (algorithm !== NODE_VERIFIER_ALGORITHM) return Promise.resolve(false);
    const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' });
    return Promise.resolve(verify(null, signingInput, key, Buffer.from(signature, 'base64url')));
  },
};

/** A lookup port returning a fixed row — the shape `verifyDeviceAssertion` now requires (codex F3). */
function lookupOf(publicKeyJwkX: string, revoked = false) {
  return () => ({ publicKeyJwkX, revoked });
}

function freshJti(): string {
  return randomBytes(16).toString('base64url');
}

function signedEnvelope(
  privateKey: KeyObject,
  overrides: Partial<DeviceAssertionClaims> = {},
): DeviceAssertionEnvelopeV1 {
  const issuedAt = overrides.issuedAt ?? '2026-08-12T04:45:00.000Z';
  const claims = parseClaims({
    version: 1,
    issuer: 'https://api.example.com',
    productId: 'product-a',
    deviceId: 'device-1',
    audience: 'salesko-api',
    jti: freshJti(),
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + DEVICE_ASSERTION_DEFAULT_TTL_MS).toISOString(),
    ...overrides,
  });
  return {
    schema: DEVICE_ASSERTION_SCHEMA_ID,
    algorithm: 'ed25519',
    protected: claims,
    signature: sign(null, deviceAssertionSigningInput(claims), privateKey).toString('base64url'),
  };
}

describe('envelope parsing is fail-closed', () => {
  const keys = generateKeyPairSync('ed25519');
  const valid = signedEnvelope(keys.privateKey);

  it('accepts a well-formed envelope', () => {
    expect(parseDeviceAssertionEnvelope(valid).protected.audience).toBe('salesko-api');
  });

  const rejected: readonly (readonly [string, unknown])[] = [
    ['a device proof envelope', { schema: 'byok-device-proof-v1', algorithm: 'ed25519', protected: PROOF_CLAIMS, signature: valid.signature }],
    ['an unknown algorithm', { ...valid, algorithm: 'rsa' }],
    ['an extra top-level key', { ...valid, devicePublicKey: 'x' }],
    ['an extra claim', { ...valid, protected: { ...valid.protected, keyId: 'key-1' } }],
    ['a missing claim', { ...valid, protected: { ...valid.protected, jti: undefined } }],
    ['an array audience', { ...valid, protected: { ...valid.protected, audience: ['a', 'b'] } }],
    ['a short jti', { ...valid, protected: { ...valid.protected, jti: 'tooshort' } }],
    ['a padded-base64 signature', { ...valid, signature: `${valid.signature.slice(0, 84)}==` }],
    ['a truncated signature', { ...valid, signature: valid.signature.slice(0, 80) }],
    ['a non-object', 'not-an-envelope'],
  ];

  for (const [name, input] of rejected) {
    it(`rejects ${name}`, () => {
      expect(() => parseDeviceAssertionEnvelope(input)).toThrow();
      try {
        parseDeviceAssertionEnvelope(input);
      } catch (err) {
        expect(isCoreError(err, 'assertion_envelope_invalid')).toBe(true);
      }
    });
  }

  it('rejects an audience over the byte bound while accepting one exactly at it', () => {
    const atBound = 'a'.repeat(DEVICE_ASSERTION_AUDIENCE_MAX_BYTES);
    expect(() => parseClaims({ ...valid.protected, audience: atBound })).not.toThrow();
    expect(() => parseClaims({ ...valid.protected, audience: `${atBound}a` })).toThrow();
    // Bounded in BYTES, not code units: a 128-character multi-byte audience is
    // already over the limit.
    expect(() => parseClaims({ ...valid.protected, audience: '受'.repeat(86) })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// verifyDeviceAssertion
// ---------------------------------------------------------------------------

describe('verifyDeviceAssertion', () => {
  const keys = generateKeyPairSync('ed25519');
  const devicePublicKey = (keys.publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const base = { verifier: nodeVerifier, lookupDevice: lookupOf(devicePublicKey) } as const;

  it('returns the claims for a valid, in-window, non-revoked assertion', async () => {
    const envelope = signedEnvelope(keys.privateKey);
    const claims = await verifyDeviceAssertion(envelope, {
      ...base,
      now: new Date(Date.parse(envelope.protected.issuedAt) + 1_000),
    });
    expect(claims?.jti).toBe(envelope.protected.jti);
    expect(claims?.audience).toBe('salesko-api');
  });

  it('looks the row up by the CLAIMED deviceId and uses that row\'s key, never an argument key', async () => {
    // The caller cannot pass a key directly — it can only provide a lookup, and
    // the lookup is invoked with the deviceId FROM the claims. Proves the
    // authority is the row, resolved by the claimed identity.
    const envelope = signedEnvelope(keys.privateKey);
    let lookedUpWith: string | undefined;
    const claims = await verifyDeviceAssertion(envelope, {
      verifier: nodeVerifier,
      lookupDevice: (deviceId) => {
        lookedUpWith = deviceId;
        return { publicKeyJwkX: devicePublicKey, revoked: false };
      },
      now: new Date(Date.parse(envelope.protected.issuedAt) + 1_000),
    });
    expect(lookedUpWith).toBe(envelope.protected.deviceId);
    expect(claims).toBeDefined();
  });

  it('returns undefined when the lookup finds no such device, without doing any crypto', async () => {
    const envelope = signedEnvelope(keys.privateKey);
    let verifierCalled = false;
    const spy: DeviceAssertionVerifier = {
      verify: (input) => {
        verifierCalled = true;
        return nodeVerifier.verify(input);
      },
    };
    await expect(
      verifyDeviceAssertion(envelope, {
        verifier: spy,
        lookupDevice: () => undefined,
        now: new Date(Date.parse(envelope.protected.issuedAt) + 1_000),
      }),
    ).resolves.toBeUndefined();
    expect(verifierCalled).toBe(false);
  });

  it('returns undefined when the row says revoked, without doing any crypto', async () => {
    const envelope = signedEnvelope(keys.privateKey);
    let verifierCalled = false;
    const spy: DeviceAssertionVerifier = {
      verify: (input) => {
        verifierCalled = true;
        return nodeVerifier.verify(input);
      },
    };
    await expect(
      verifyDeviceAssertion(envelope, {
        verifier: spy,
        lookupDevice: lookupOf(devicePublicKey, true),
        now: new Date(Date.parse(envelope.protected.issuedAt) + 1_000),
      }),
    ).resolves.toBeUndefined();
    expect(verifierCalled).toBe(false);
  });

  it('awaits an async lookup port', async () => {
    const envelope = signedEnvelope(keys.privateKey);
    const claims = await verifyDeviceAssertion(envelope, {
      verifier: nodeVerifier,
      lookupDevice: async (deviceId) => {
        await Promise.resolve();
        expect(deviceId).toBe(envelope.protected.deviceId);
        return { publicKeyJwkX: devicePublicKey, revoked: false };
      },
      now: new Date(Date.parse(envelope.protected.issuedAt) + 1_000),
    });
    expect(claims).toBeDefined();
  });

  it('codex F2: rejects a malformed lookup row before any crypto, failing closed', async () => {
    const envelope = signedEnvelope(keys.privateKey);
    const now = new Date(Date.parse(envelope.protected.issuedAt) + 1_000);
    let verifierCalled = false;
    const spyVerifier: DeviceAssertionVerifier = {
      verify: (input) => {
        verifierCalled = true;
        return nodeVerifier.verify(input);
      },
    };
    // Each row is a shape a careless caller could return at runtime — TypeScript
    // cannot stop it, so the verifier validates strictly. `as never` bypasses
    // the compile-time type exactly as a JS caller would at runtime.
    const malformedRows: readonly (readonly [string, unknown])[] = [
      ['no revoked field (undefined must not read as not-revoked)', { publicKeyJwkX: devicePublicKey }],
      ['revoked as the string "no"', { publicKeyJwkX: devicePublicKey, revoked: 'no' }],
      ['revoked truthy', { publicKeyJwkX: devicePublicKey, revoked: 1 }],
      ['revoked null', { publicKeyJwkX: devicePublicKey, revoked: null }],
      ['missing key', { revoked: false }],
      ['empty-string key', { publicKeyJwkX: '', revoked: false }],
      ['malformed (too short) key', { publicKeyJwkX: 'abc', revoked: false }],
      ['non-string key', { publicKeyJwkX: 123, revoked: false }],
      ['row is null', null],
      ['row is a string', 'not-a-row'],
    ];
    for (const [name, row] of malformedRows) {
      verifierCalled = false;
      await expect(
        verifyDeviceAssertion(envelope, { verifier: spyVerifier, lookupDevice: () => row as never, now }),
        name,
      ).resolves.toBeUndefined();
      expect(verifierCalled, `${name}: must reject before crypto`).toBe(false);
    }

    // Sanity: the exact-shape row (revoked === false, well-formed key) is the
    // only one that passes.
    await expect(
      verifyDeviceAssertion(envelope, {
        verifier: nodeVerifier,
        lookupDevice: () => ({ publicKeyJwkX: devicePublicKey, revoked: false }),
        now,
      }),
    ).resolves.toBeDefined();
  });

  it('treats expiry as a half-open interval: rejects at the exact expiresAt instant', async () => {
    // codex F5: validity is `[issuedAt, expiresAt)` — at `expiresAt` itself the
    // assertion is already expired.
    const envelope = signedEnvelope(keys.privateKey);
    const expiresAt = Date.parse(envelope.protected.expiresAt);
    await expect(
      verifyDeviceAssertion(envelope, { ...base, now: new Date(expiresAt - 1) }),
    ).resolves.toBeDefined();
    await expect(
      verifyDeviceAssertion(envelope, { ...base, now: new Date(expiresAt) }),
    ).resolves.toBeUndefined();
    await expect(
      verifyDeviceAssertion(envelope, { ...base, now: new Date(expiresAt + 1) }),
    ).resolves.toBeUndefined();
  });

  it('returns undefined before the assertion was issued', async () => {
    const envelope = signedEnvelope(keys.privateKey);
    await expect(
      verifyDeviceAssertion(envelope, {
        ...base,
        now: new Date(Date.parse(envelope.protected.issuedAt) - 1),
      }),
    ).resolves.toBeUndefined();
    // Accepts at the exact issuedAt instant (the interval is closed at the left).
    await expect(
      verifyDeviceAssertion(envelope, {
        ...base,
        now: new Date(Date.parse(envelope.protected.issuedAt)),
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a self-minted lifetime longer than the hard ceiling', async () => {
    const issuedAt = '2026-08-12T04:45:00.000Z';
    const overLong = signedEnvelope(keys.privateKey, {
      issuedAt,
      expiresAt: new Date(Date.parse(issuedAt) + DEVICE_ASSERTION_MAX_TTL_MS + 1).toISOString(),
    });
    await expect(
      verifyDeviceAssertion(overLong, { ...base, now: new Date(Date.parse(issuedAt) + 1_000) }),
    ).resolves.toBeUndefined();

    const atCeiling = signedEnvelope(keys.privateKey, {
      issuedAt,
      expiresAt: new Date(Date.parse(issuedAt) + DEVICE_ASSERTION_MAX_TTL_MS).toISOString(),
    });
    await expect(
      verifyDeviceAssertion(atCeiling, { ...base, now: new Date(Date.parse(issuedAt) + 1_000) }),
    ).resolves.toBeDefined();
  });

  it('refuses a maxLifetimeMs above the hard ceiling rather than honouring it', async () => {
    const envelope = signedEnvelope(keys.privateKey);
    for (const maxLifetimeMs of [DEVICE_ASSERTION_MAX_TTL_MS + 1, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        verifyDeviceAssertion(envelope, {
          ...base,
          maxLifetimeMs,
          now: new Date(Date.parse(envelope.protected.issuedAt) + 1_000),
        }),
      ).resolves.toBeUndefined();
    }
  });

  it('returns undefined for a signature made by a different device key', async () => {
    const other = generateKeyPairSync('ed25519');
    const envelope = signedEnvelope(other.privateKey);
    // The row still returns the REGISTERED key; the envelope was signed by a
    // different one, so the signature fails.
    await expect(
      verifyDeviceAssertion(envelope, {
        ...base,
        now: new Date(Date.parse(envelope.protected.issuedAt) + 1_000),
      }),
    ).resolves.toBeUndefined();
  });

  it('returns undefined when any signed claim was tampered with after signing', async () => {
    const envelope = signedEnvelope(keys.privateKey);
    const now = new Date(Date.parse(envelope.protected.issuedAt) + 1_000);
    const tampered: readonly Partial<DeviceAssertionClaims>[] = [
      { audience: 'other-api' },
      { deviceId: 'device-2' },
      { issuer: 'https://evil.example.com' },
      { productId: 'product-b' },
      { jti: freshJti() },
    ];
    for (const patch of tampered) {
      await expect(
        verifyDeviceAssertion(
          { ...envelope, protected: { ...envelope.protected, ...patch } },
          { ...base, now },
        ),
      ).resolves.toBeUndefined();
    }
  });

  it('returns undefined for malformed input rather than throwing', async () => {
    for (const input of [undefined, null, 42, 'x', {}, { schema: DEVICE_ASSERTION_SCHEMA_ID }]) {
      await expect(
        verifyDeviceAssertion(input, { ...base, now: new Date('2026-08-12T04:45:01.000Z') }),
      ).resolves.toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// authenticateDeviceAssertion
// ---------------------------------------------------------------------------

describe('authenticateDeviceAssertion', () => {
  const keys = generateKeyPairSync('ed25519');
  const devicePublicKey = (keys.publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const expected = {
    issuer: 'https://api.example.com',
    productId: 'product-a',
    audience: 'salesko-api',
  } as const;

  function deps(replay: DeviceAssertionReplayAuthority = new InMemoryDeviceAssertionReplayAuthority()) {
    return {
      verifier: nodeVerifier,
      lookupDevice: () => ({
        tenantId: tenantId('tenant-a'),
        productId: 'product-a',
        deviceId: 'device-1',
        publicKeyJwkX: devicePublicKey,
        revoked: false,
      }),
      replay,
      expected,
      now: new Date('2026-08-12T04:45:01.000Z'),
    } as const;
  }

  it('returns a row-derived principal and consumes a valid assertion exactly once', async () => {
    const envelope = signedEnvelope(keys.privateKey);
    const replay = new InMemoryDeviceAssertionReplayAuthority();

    await expect(authenticateDeviceAssertion(envelope, deps(replay))).resolves.toMatchObject({
      // §8.1: the result carries its own lane discriminator, so a consumer that
      // must accept ONLY device authority can say so in one comparison instead
      // of inferring it from which task-shaped fields happen to be absent.
      lane: 'device',
      device: {
        kind: 'device',
        tenantId: 'tenant-a',
        productId: 'product-a',
        deviceId: 'device-1',
      },
      issuer: expected.issuer,
      audience: expected.audience,
      jti: envelope.protected.jti,
    });
    await expect(authenticateDeviceAssertion(envelope, deps(replay))).resolves.toBeUndefined();
  });

  it('lets exactly one concurrent consumer authenticate the same assertion', async () => {
    const envelope = signedEnvelope(keys.privateKey);
    const replay = new InMemoryDeviceAssertionReplayAuthority();
    const results = await Promise.all(
      Array.from({ length: 16 }, () => authenticateDeviceAssertion(envelope, deps(replay))),
    );
    expect(results.filter((result) => result !== undefined)).toHaveLength(1);
  });

  it('rejects every trusted-binding mismatch before consuming the JTI', async () => {
    const envelope = signedEnvelope(keys.privateKey);
    for (const patch of [
      { issuer: 'https://other.example.com' },
      { productId: 'product-b' },
      { audience: 'other-api' },
    ]) {
      let consumed = false;
      await expect(
        authenticateDeviceAssertion(envelope, {
          ...deps({
            consume: () => {
              consumed = true;
              return Promise.resolve(true);
            },
          }),
          expected: { ...expected, ...patch },
        }),
      ).resolves.toBeUndefined();
      expect(consumed).toBe(false);
    }
  });

  it('rejects a row whose product or device identity does not match the requested authority', async () => {
    const envelope = signedEnvelope(keys.privateKey);
    for (const rowPatch of [
      { productId: 'product-b' },
      { deviceId: 'device-2' },
    ]) {
      await expect(
        authenticateDeviceAssertion(envelope, {
          ...deps(),
          lookupDevice: () => ({
            tenantId: tenantId('tenant-a'),
            productId: 'product-a',
            deviceId: 'device-1',
            publicKeyJwkX: devicePublicKey,
            revoked: false,
            ...rowPatch,
          }),
        }),
      ).resolves.toBeUndefined();
    }
  });

  it('propagates replay-authority failures instead of degrading to signature-only auth', async () => {
    const envelope = signedEnvelope(keys.privateKey);
    await expect(
      authenticateDeviceAssertion(
        envelope,
        deps({
          consume: () => Promise.reject(new Error('replay authority unavailable')),
        }),
      ),
    ).rejects.toThrow('replay authority unavailable');
  });

  it('cleans only expired replay keys and honors the cleanup limit', async () => {
    const replay = new InMemoryDeviceAssertionReplayAuthority();
    const input = {
      schema: DEVICE_ASSERTION_SCHEMA_ID,
      tenantId: tenantId('tenant-a'),
      issuer: expected.issuer,
      productId: expected.productId,
      deviceId: 'device-1',
      audience: expected.audience,
      jti: freshJti(),
      expiresAt: '2026-08-12T04:47:00.000Z',
    } as const;
    await expect(replay.consume(input)).resolves.toBe(true);
    await expect(replay.deleteExpired(new Date('2026-08-12T04:46:59.999Z'), 1)).resolves.toBe(0);
    await expect(replay.consume(input)).resolves.toBe(false);
    await expect(replay.deleteExpired(new Date(input.expiresAt), 1)).resolves.toBe(1);
    await expect(replay.consume(input)).resolves.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task assertion (`byok-task-assertion-v1`) — contract §8.1 / §8.2(2) / AC11
// ---------------------------------------------------------------------------

const TASK_GOLDEN_URL = new URL('./golden/task-assertion-v1.canonical.json', import.meta.url);

/** The task claim sets the golden pins. Extending this list is an additive change. */
const TASK_GOLDEN_INPUTS: readonly { readonly name: string; readonly claims: unknown }[] = [
  {
    name: 'minimal ascii claim set',
    claims: {
      version: 1,
      issuer: 'https://api.example.com',
      productId: 'product-a',
      deviceId: 'device-1',
      audience: 'salesko-api',
      jti: 'AAAAAAAAAAAAAAAAAAAAAA',
      issuedAt: '2026-08-12T04:45:00.000Z',
      expiresAt: '2026-08-12T04:47:00.000Z',
      taskId: 'task-1',
      agentRef: { agentId: 'agent-1', profileRevision: 'rev-1' },
      toolsetId: 'salesko.read.v1',
    },
  },
  {
    name: 'non-ascii claims and a slash-bearing profile revision',
    claims: {
      version: 1,
      issuer: 'https://staging.example.com:8443',
      productId: '产品-b',
      deviceId: 'device-2',
      audience: '受众/"quoted"\u0000',
      jti: 'ZmFrZS1qdGktZm9yLWdvbA',
      issuedAt: '2026-08-12T04:45:00.000Z',
      expiresAt: '2026-08-12T04:50:00.000Z',
      taskId: '任务/"2"',
      // `profileRevision` is deliberately NOT a pathname segment: only
      // `agentId` carries that rule, and pinning a slash here proves the two
      // AgentRef scalars keep their different validators through the canonical
      // bytes.
      agentRef: { agentId: '代理-b', profileRevision: 'rev/2' },
      toolsetId: 'salesko.propose.v1',
    },
  },
];

interface TaskGoldenCase {
  readonly name: string;
  readonly claims: unknown;
  readonly canonicalJson: string;
  readonly signingInputUtf8: string;
  readonly signingInputHex: string;
}

interface TaskGoldenFile {
  readonly schema: string;
  readonly domainPrefix: string;
  readonly note: string;
  readonly cases: readonly TaskGoldenCase[];
}

function parseTaskClaims(input: unknown): TaskAssertionClaims {
  return TaskAssertionClaimsSchema.parse(input);
}

function buildTaskGolden(): TaskGoldenFile {
  return {
    schema: TASK_ASSERTION_SCHEMA_ID,
    domainPrefix: TASK_ASSERTION_DOMAIN_PREFIX,
    note: 'Canonical signing bytes for byok-task-assertion-v1. Regenerate with BYOK_CORE_UPDATE_GOLDEN=1 bun run --filter @byok-sdk/core test, and treat any diff as a breaking change to the signature format.',
    cases: TASK_GOLDEN_INPUTS.map((input) => {
      const claims = parseTaskClaims(input.claims);
      return {
        name: input.name,
        claims: input.claims,
        canonicalJson: taskAssertionCanonicalJson(claims),
        signingInputUtf8: TASK_ASSERTION_DOMAIN_PREFIX + taskAssertionCanonicalJson(claims),
        signingInputHex: toHex(taskAssertionSigningInput(claims)),
      };
    }),
  };
}

if (process.env['BYOK_CORE_UPDATE_GOLDEN'] === '1') {
  writeFileSync(TASK_GOLDEN_URL, `${JSON.stringify(buildTaskGolden(), null, 2)}\n`, 'utf8');
}

const taskGolden = JSON.parse(readFileSync(TASK_GOLDEN_URL, 'utf8')) as TaskGoldenFile;

describe('task assertion golden', () => {
  it('covers every pinned claim set', () => {
    expect(taskGolden.cases.map((entry) => entry.name)).toEqual(TASK_GOLDEN_INPUTS.map((input) => input.name));
    expect(taskGolden.domainPrefix).toBe('byok-task-assertion-v1\n');
    expect(taskGolden.schema).toBe('byok-task-assertion-v1');
  });

  for (const [index, input] of TASK_GOLDEN_INPUTS.entries()) {
    it(`reproduces the frozen bytes: ${input.name}`, () => {
      const expected = taskGolden.cases[index]!;
      const claims = parseTaskClaims(input.claims);

      expect(taskAssertionCanonicalJson(claims)).toBe(expected.canonicalJson);
      expect(toHex(taskAssertionSigningInput(claims))).toBe(expected.signingInputHex);
      expect(expected.signingInputUtf8.startsWith(TASK_ASSERTION_DOMAIN_PREFIX)).toBe(true);
      expect(expected.signingInputUtf8).toBe(TASK_ASSERTION_DOMAIN_PREFIX + expected.canonicalJson);
    });
  }

  it('is invariant under claim key insertion order, nested AgentRef included', () => {
    for (const input of TASK_GOLDEN_INPUTS) {
      const entries = Object.entries(input.claims as Record<string, unknown>);
      const reversed = Object.fromEntries([...entries].reverse());
      const rotated = Object.fromEntries([...entries.slice(3), ...entries.slice(0, 3)]);
      const baseline = toHex(taskAssertionSigningInput(parseTaskClaims(input.claims)));
      expect(toHex(taskAssertionSigningInput(parseTaskClaims(reversed)))).toBe(baseline);
      expect(toHex(taskAssertionSigningInput(parseTaskClaims(rotated)))).toBe(baseline);

      const agentRef = (input.claims as { agentRef: Record<string, unknown> }).agentRef;
      const swappedAgentRef = {
        ...(input.claims as Record<string, unknown>),
        agentRef: Object.fromEntries([...Object.entries(agentRef)].reverse()),
      };
      expect(toHex(taskAssertionSigningInput(parseTaskClaims(swappedAgentRef)))).toBe(baseline);
    }
  });

  it('signs every claim, the three task-scoped ones included (§8.1)', () => {
    const claims = parseTaskClaims(TASK_GOLDEN_INPUTS[0]!.claims);
    expect(Object.keys(taskAssertionCanonicalClaims(claims)).sort()).toEqual([
      'agentRef',
      'audience',
      'deviceId',
      'expiresAt',
      'issuedAt',
      'issuer',
      'jti',
      'productId',
      'taskId',
      'toolsetId',
      'version',
    ]);
    // The canonical bytes, not just the projection object: a claim the
    // projection carried but canonicalization dropped would still be unsigned.
    const canonical = taskAssertionCanonicalJson(claims);
    for (const claim of ['taskId', 'agentRef', 'agentId', 'profileRevision', 'toolsetId']) {
      expect(canonical).toContain(claim);
    }
  });

  it('carries no devicePublicKey, no caller identity, and no keyId', () => {
    const canonical = taskAssertionCanonicalJson(parseTaskClaims(TASK_GOLDEN_INPUTS[0]!.claims));
    for (const forbidden of ['devicePublicKey', 'keyId', 'callerPid', 'callerUid', 'caller']) {
      expect(canonical).not.toContain(forbidden);
    }
  });
});

function signedTaskEnvelope(
  privateKey: KeyObject,
  overrides: Partial<TaskAssertionClaims> = {},
): TaskAssertionEnvelopeV1 {
  const issuedAt = overrides.issuedAt ?? '2026-08-12T04:45:00.000Z';
  const claims = parseTaskClaims({
    version: 1,
    issuer: 'https://api.example.com',
    productId: 'product-a',
    deviceId: 'device-1',
    audience: 'salesko-api',
    jti: freshJti(),
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + DEVICE_ASSERTION_DEFAULT_TTL_MS).toISOString(),
    taskId: 'task-1',
    agentRef: { agentId: 'agent-1', profileRevision: 'rev-1' },
    toolsetId: 'salesko.read.v1',
    ...overrides,
  });
  return {
    schema: TASK_ASSERTION_SCHEMA_ID,
    algorithm: 'ed25519',
    protected: claims,
    signature: sign(null, taskAssertionSigningInput(claims), privateKey).toString('base64url'),
  };
}

// ---------------------------------------------------------------------------
// Falsifier: the two envelopes are not interchangeable in either direction
// ---------------------------------------------------------------------------

describe('device and task envelopes are not interchangeable (§8.1 falsifier)', () => {
  const keys = generateKeyPairSync('ed25519');
  const devicePublicKey = (keys.publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const base = { verifier: nodeVerifier, lookupDevice: lookupOf(devicePublicKey) } as const;

  it('parses each envelope only under its own parser', () => {
    const device = signedEnvelope(keys.privateKey);
    const task = signedTaskEnvelope(keys.privateKey);

    expect(parseDeviceAssertionEnvelope(device).schema).toBe(DEVICE_ASSERTION_SCHEMA_ID);
    expect(parseTaskAssertionEnvelope(task).schema).toBe(TASK_ASSERTION_SCHEMA_ID);

    // A device envelope is NOT a task assertion missing some optional claims:
    // the task claim set is strict and required, so it fails closed.
    expect(() => parseTaskAssertionEnvelope(device)).toThrow();
    expect(isCoreError(tryParse(() => parseTaskAssertionEnvelope(device)), 'assertion_envelope_invalid')).toBe(true);

    // And a task envelope is not a device assertion with extra claims: the
    // device claim set is strict too, so the added claims are unknown keys.
    expect(() => parseDeviceAssertionEnvelope(task)).toThrow();
    expect(isCoreError(tryParse(() => parseDeviceAssertionEnvelope(task)), 'assertion_envelope_invalid')).toBe(true);
  });

  it('rejects each envelope in the other lane\'s verifier, even with a valid signature', async () => {
    const device = signedEnvelope(keys.privateKey);
    const task = signedTaskEnvelope(keys.privateKey);
    const now = new Date(Date.parse(device.protected.issuedAt) + 1_000);

    // Both are genuinely valid in their own lane...
    await expect(verifyDeviceAssertion(device, { ...base, now })).resolves.toBeDefined();
    await expect(verifyTaskAssertion(task, { ...base, now })).resolves.toBeDefined();

    // ...and neither crosses over.
    await expect(verifyTaskAssertion(device, { ...base, now })).resolves.toBeUndefined();
    await expect(verifyDeviceAssertion(task, { ...base, now })).resolves.toBeUndefined();
  });

  it('rejects a claim set re-labelled with the other lane\'s schema id', async () => {
    // The strongest form of the falsifier: keep the signature and the claims,
    // change ONLY the schema tag. Neither parser accepts a mislabelled
    // envelope, so a lane cannot be switched by editing one string.
    const device = signedEnvelope(keys.privateKey);
    const task = signedTaskEnvelope(keys.privateKey);
    const now = new Date(Date.parse(device.protected.issuedAt) + 1_000);

    await expect(
      verifyTaskAssertion({ ...device, schema: TASK_ASSERTION_SCHEMA_ID }, { ...base, now }),
    ).resolves.toBeUndefined();
    await expect(
      verifyDeviceAssertion({ ...task, schema: DEVICE_ASSERTION_SCHEMA_ID }, { ...base, now }),
    ).resolves.toBeUndefined();
  });

  it('a task-domain signature does not verify over the device domain, and vice versa', () => {
    // Domain separation, checked at the raw-signature level: even where the
    // schemas were made to coincide, the signed BYTES differ in their first
    // line, so neither signature is reusable in the other lane.
    const taskClaims = parseTaskClaims(TASK_GOLDEN_INPUTS[0]!.claims);
    const deviceClaims = parseClaims(GOLDEN_INPUTS[0]!.claims);

    const taskSignature = Buffer.from(sign(null, taskAssertionSigningInput(taskClaims), keys.privateKey));
    const deviceSignature = Buffer.from(sign(null, deviceAssertionSigningInput(deviceClaims), keys.privateKey));

    expect(verify(null, taskAssertionSigningInput(taskClaims), keys.publicKey, taskSignature)).toBe(true);
    expect(verify(null, deviceAssertionSigningInput(deviceClaims), keys.publicKey, taskSignature)).toBe(false);
    expect(verify(null, taskAssertionSigningInput(taskClaims), keys.publicKey, deviceSignature)).toBe(false);
  });
});

function tryParse(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (err) {
    return err;
  }
}

// ---------------------------------------------------------------------------
// Task envelope parsing
// ---------------------------------------------------------------------------

describe('task envelope parsing is fail-closed', () => {
  const keys = generateKeyPairSync('ed25519');
  const valid = signedTaskEnvelope(keys.privateKey);

  it('accepts a well-formed envelope', () => {
    const parsed = parseTaskAssertionEnvelope(valid);
    expect(parsed.protected.taskId).toBe('task-1');
    expect(parsed.protected.agentRef).toEqual({ agentId: 'agent-1', profileRevision: 'rev-1' });
    expect(parsed.protected.toolsetId).toBe('salesko.read.v1');
  });

  const rejected: readonly (readonly [string, unknown])[] = [
    ['a device assertion envelope', { schema: DEVICE_ASSERTION_SCHEMA_ID, algorithm: 'ed25519', protected: valid.protected, signature: valid.signature }],
    ['an unknown algorithm', { ...valid, algorithm: 'rsa' }],
    ['an extra top-level key', { ...valid, devicePublicKey: 'x' }],
    ['an extra claim', { ...valid, protected: { ...valid.protected, keyId: 'key-1' } }],
    ['a missing taskId', { ...valid, protected: { ...valid.protected, taskId: undefined } }],
    ['an empty taskId', { ...valid, protected: { ...valid.protected, taskId: '' } }],
    ['a missing agentRef', { ...valid, protected: { ...valid.protected, agentRef: undefined } }],
    ['a missing toolsetId', { ...valid, protected: { ...valid.protected, toolsetId: undefined } }],
    ['an agentRef missing profileRevision', { ...valid, protected: { ...valid.protected, agentRef: { agentId: 'agent-1' } } }],
    ['an agentRef with an extra member', { ...valid, protected: { ...valid.protected, agentRef: { agentId: 'agent-1', profileRevision: 'rev-1', tenantId: 'tenant-a' } } }],
    ['a string agentRef', { ...valid, protected: { ...valid.protected, agentRef: 'agent-1' } }],
    ['an agentId that is a dot segment', { ...valid, protected: { ...valid.protected, agentRef: { agentId: '..', profileRevision: 'rev-1' } } }],
    ['an agentId carrying a path separator', { ...valid, protected: { ...valid.protected, agentRef: { agentId: 'a/b', profileRevision: 'rev-1' } } }],
    ['an agentId that is a Windows device name', { ...valid, protected: { ...valid.protected, agentRef: { agentId: 'CON', profileRevision: 'rev-1' } } }],
    ['an agentId with a control character', { ...valid, protected: { ...valid.protected, agentRef: { agentId: 'a\u0001b', profileRevision: 'rev-1' } } }],
    ['an over-long profileRevision', { ...valid, protected: { ...valid.protected, agentRef: { agentId: 'agent-1', profileRevision: 'r'.repeat(161) } } }],
    ['an uppercase toolsetId', { ...valid, protected: { ...valid.protected, toolsetId: 'Salesko.Read.V1' } }],
    ['a toolsetId with a trailing separator', { ...valid, protected: { ...valid.protected, toolsetId: 'salesko.read.' } }],
    ['an array audience', { ...valid, protected: { ...valid.protected, audience: ['a', 'b'] } }],
    ['a short jti', { ...valid, protected: { ...valid.protected, jti: 'tooshort' } }],
    ['a padded-base64 signature', { ...valid, signature: `${valid.signature.slice(0, 84)}==` }],
    ['a truncated signature', { ...valid, signature: valid.signature.slice(0, 80) }],
    ['a non-object', 'not-an-envelope'],
  ];

  for (const [name, input] of rejected) {
    it(`rejects ${name}`, () => {
      expect(() => parseTaskAssertionEnvelope(input)).toThrow();
      expect(isCoreError(tryParse(() => parseTaskAssertionEnvelope(input)), 'assertion_envelope_invalid')).toBe(true);
    });
  }

  it('inherits the device lane\'s audience byte bound rather than defining its own', () => {
    const atBound = 'a'.repeat(DEVICE_ASSERTION_AUDIENCE_MAX_BYTES);
    expect(() => parseTaskClaims({ ...valid.protected, audience: atBound })).not.toThrow();
    expect(() => parseTaskClaims({ ...valid.protected, audience: `${atBound}a` })).toThrow();
    expect(() => parseTaskClaims({ ...valid.protected, audience: '受'.repeat(86) })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// verifyTaskAssertion
// ---------------------------------------------------------------------------

describe('verifyTaskAssertion', () => {
  const keys = generateKeyPairSync('ed25519');
  const devicePublicKey = (keys.publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const base = { verifier: nodeVerifier, lookupDevice: lookupOf(devicePublicKey) } as const;

  it('returns the claims for a valid, in-window, non-revoked assertion', async () => {
    const envelope = signedTaskEnvelope(keys.privateKey);
    const claims = await verifyTaskAssertion(envelope, {
      ...base,
      now: new Date(Date.parse(envelope.protected.issuedAt) + 1_000),
    });
    expect(claims?.taskId).toBe('task-1');
    expect(claims?.agentRef.agentId).toBe('agent-1');
    expect(claims?.toolsetId).toBe('salesko.read.v1');
  });

  it('rejects an unknown or revoked device row before doing any crypto', async () => {
    const envelope = signedTaskEnvelope(keys.privateKey);
    const now = new Date(Date.parse(envelope.protected.issuedAt) + 1_000);
    for (const lookupDevice of [() => undefined, lookupOf(devicePublicKey, true)]) {
      let verifierCalled = false;
      const spy: DeviceAssertionVerifier = {
        verify: (input) => {
          verifierCalled = true;
          return nodeVerifier.verify(input);
        },
      };
      await expect(
        verifyTaskAssertion(envelope, { verifier: spy, lookupDevice, now }),
      ).resolves.toBeUndefined();
      expect(verifierCalled).toBe(false);
    }
  });

  it('applies the device lane\'s window and ceiling, not a task-shaped one', async () => {
    const issuedAt = '2026-08-12T04:45:00.000Z';
    const envelope = signedTaskEnvelope(keys.privateKey, { issuedAt });
    const expiresAt = Date.parse(envelope.protected.expiresAt);

    await expect(verifyTaskAssertion(envelope, { ...base, now: new Date(expiresAt - 1) })).resolves.toBeDefined();
    await expect(verifyTaskAssertion(envelope, { ...base, now: new Date(expiresAt) })).resolves.toBeUndefined();
    await expect(
      verifyTaskAssertion(envelope, { ...base, now: new Date(Date.parse(issuedAt) - 1) }),
    ).resolves.toBeUndefined();

    const overLong = signedTaskEnvelope(keys.privateKey, {
      issuedAt,
      expiresAt: new Date(Date.parse(issuedAt) + DEVICE_ASSERTION_MAX_TTL_MS + 1).toISOString(),
    });
    await expect(
      verifyTaskAssertion(overLong, { ...base, now: new Date(Date.parse(issuedAt) + 1_000) }),
    ).resolves.toBeUndefined();

    const atCeiling = signedTaskEnvelope(keys.privateKey, {
      issuedAt,
      expiresAt: new Date(Date.parse(issuedAt) + DEVICE_ASSERTION_MAX_TTL_MS).toISOString(),
    });
    await expect(
      verifyTaskAssertion(atCeiling, { ...base, now: new Date(Date.parse(issuedAt) + 1_000) }),
    ).resolves.toBeDefined();

    for (const maxLifetimeMs of [DEVICE_ASSERTION_MAX_TTL_MS + 1, 0, -1, Number.NaN]) {
      await expect(
        verifyTaskAssertion(envelope, {
          ...base,
          maxLifetimeMs,
          now: new Date(Date.parse(issuedAt) + 1_000),
        }),
      ).resolves.toBeUndefined();
    }
  });

  it('returns undefined when any signed claim was tampered with after signing', async () => {
    const envelope = signedTaskEnvelope(keys.privateKey);
    const now = new Date(Date.parse(envelope.protected.issuedAt) + 1_000);
    const tampered: readonly Partial<TaskAssertionClaims>[] = [
      { audience: 'other-api' },
      { deviceId: 'device-2' },
      { issuer: 'https://evil.example.com' },
      { productId: 'product-b' },
      { jti: freshJti() },
      { taskId: 'task-2' },
      { agentRef: { agentId: 'agent-2', profileRevision: 'rev-1' } },
      { agentRef: { agentId: 'agent-1', profileRevision: 'rev-2' } },
      { toolsetId: 'salesko.propose.v1' },
    ];
    for (const patch of tampered) {
      await expect(
        verifyTaskAssertion({ ...envelope, protected: { ...envelope.protected, ...patch } }, { ...base, now }),
        JSON.stringify(patch),
      ).resolves.toBeUndefined();
    }
  });

  it('returns undefined for a signature made by a different device key', async () => {
    const other = generateKeyPairSync('ed25519');
    const envelope = signedTaskEnvelope(other.privateKey);
    await expect(
      verifyTaskAssertion(envelope, {
        ...base,
        now: new Date(Date.parse(envelope.protected.issuedAt) + 1_000),
      }),
    ).resolves.toBeUndefined();
  });

  it('returns undefined for malformed input rather than throwing', async () => {
    for (const input of [undefined, null, 42, 'x', {}, { schema: TASK_ASSERTION_SCHEMA_ID }]) {
      await expect(
        verifyTaskAssertion(input, { ...base, now: new Date('2026-08-12T04:45:01.000Z') }),
      ).resolves.toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// authenticateTaskAssertion + the shared replay ledger's schema segment
// ---------------------------------------------------------------------------

describe('authenticateTaskAssertion', () => {
  const keys = generateKeyPairSync('ed25519');
  const devicePublicKey = (keys.publicKey.export({ format: 'jwk' }) as { x: string }).x;
  const expected = {
    issuer: 'https://api.example.com',
    productId: 'product-a',
    audience: 'salesko-api',
  } as const;

  function deps(replay: DeviceAssertionReplayAuthority = new InMemoryDeviceAssertionReplayAuthority()) {
    return {
      verifier: nodeVerifier,
      lookupDevice: () => ({
        tenantId: tenantId('tenant-a'),
        productId: 'product-a',
        deviceId: 'device-1',
        publicKeyJwkX: devicePublicKey,
        revoked: false,
      }),
      replay,
      expected,
      now: new Date('2026-08-12T04:45:01.000Z'),
    } as const;
  }

  it('returns the verified task bindings and consumes the assertion exactly once', async () => {
    const envelope = signedTaskEnvelope(keys.privateKey);
    const replay = new InMemoryDeviceAssertionReplayAuthority();

    await expect(authenticateTaskAssertion(envelope, deps(replay))).resolves.toMatchObject({
      lane: 'task',
      device: { kind: 'device', tenantId: 'tenant-a', productId: 'product-a', deviceId: 'device-1' },
      issuer: expected.issuer,
      audience: expected.audience,
      jti: envelope.protected.jti,
      taskId: 'task-1',
      agentRef: { agentId: 'agent-1', profileRevision: 'rev-1' },
      toolsetId: 'salesko.read.v1',
    });
    // AC11: the second use of the same assertion is refused.
    await expect(authenticateTaskAssertion(envelope, deps(replay))).resolves.toBeUndefined();
  });

  it('is told apart from a device result by `lane` alone (§8.1)', async () => {
    // The gate finding this closes: `AuthenticatedTaskAssertion` used to be an
    // EXTENSION of the device result, so a task credential satisfied every
    // device-lane type check and the only runtime difference was which extra
    // fields happened to be present. A consumer that must accept exactly one
    // lane now compares one field, and one that forgets does not typecheck.
    const task = await authenticateTaskAssertion(signedTaskEnvelope(keys.privateKey), deps());
    const device = await authenticateDeviceAssertion(signedEnvelope(keys.privateKey), deps());

    expect(task?.lane).toBe('task');
    expect(device?.lane).toBe('device');
    expect([task, device].filter((result) => result?.lane === 'task')).toEqual([task]);
  });

  it('records the consumption under the task schema segment (§8.2(2))', async () => {
    const envelope = signedTaskEnvelope(keys.privateKey);
    const consumed: unknown[] = [];
    await expect(
      authenticateTaskAssertion(
        envelope,
        deps({
          consume: (input) => {
            consumed.push(input);
            return Promise.resolve(true);
          },
        }),
      ),
    ).resolves.toBeDefined();
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toMatchObject({
      schema: TASK_ASSERTION_SCHEMA_ID,
      tenantId: 'tenant-a',
      issuer: expected.issuer,
      productId: 'product-a',
      deviceId: 'device-1',
      audience: expected.audience,
      jti: envelope.protected.jti,
    });
  });

  it('lets exactly one concurrent consumer authenticate the same assertion', async () => {
    const envelope = signedTaskEnvelope(keys.privateKey);
    const replay = new InMemoryDeviceAssertionReplayAuthority();
    const results = await Promise.all(
      Array.from({ length: 16 }, () => authenticateTaskAssertion(envelope, deps(replay))),
    );
    expect(results.filter((result) => result !== undefined)).toHaveLength(1);
  });

  it('rejects every trusted-binding mismatch BEFORE consuming the JTI (AC11)', async () => {
    const envelope = signedTaskEnvelope(keys.privateKey);
    for (const patch of [
      { issuer: 'https://other.example.com' },
      { productId: 'product-b' },
      { audience: 'other-api' },
    ]) {
      let consumed = false;
      await expect(
        authenticateTaskAssertion(envelope, {
          ...deps({
            consume: () => {
              consumed = true;
              return Promise.resolve(true);
            },
          }),
          expected: { ...expected, ...patch },
        }),
      ).resolves.toBeUndefined();
      expect(consumed, JSON.stringify(patch)).toBe(false);
    }
  });

  it('rejects an expired, not-yet-valid, over-TTL or revoked assertion before consuming the JTI (AC11)', async () => {
    const issuedAt = '2026-08-12T04:45:00.000Z';
    const cases: readonly (readonly [string, TaskAssertionEnvelopeV1, Date, boolean])[] = [
      ['expired', signedTaskEnvelope(keys.privateKey, { issuedAt }), new Date('2026-08-12T04:47:00.000Z'), false],
      ['not yet valid', signedTaskEnvelope(keys.privateKey, { issuedAt }), new Date('2026-08-12T04:44:59.999Z'), false],
      [
        'over the hard TTL ceiling',
        signedTaskEnvelope(keys.privateKey, {
          issuedAt,
          expiresAt: new Date(Date.parse(issuedAt) + DEVICE_ASSERTION_MAX_TTL_MS + 1).toISOString(),
        }),
        new Date('2026-08-12T04:45:01.000Z'),
        false,
      ],
      ['revoked device', signedTaskEnvelope(keys.privateKey, { issuedAt }), new Date('2026-08-12T04:45:01.000Z'), true],
    ];
    for (const [name, envelope, now, revoked] of cases) {
      let consumed = false;
      await expect(
        authenticateTaskAssertion(envelope, {
          ...deps({
            consume: () => {
              consumed = true;
              return Promise.resolve(true);
            },
          }),
          lookupDevice: () => ({
            tenantId: tenantId('tenant-a'),
            productId: 'product-a',
            deviceId: 'device-1',
            publicKeyJwkX: devicePublicKey,
            revoked,
          }),
          now,
        }),
        name,
      ).resolves.toBeUndefined();
      expect(consumed, `${name}: must reject before the replay side effect`).toBe(false);
    }
  });

  it('refuses a device assertion presented to the task lane, with zero fallback (§8.1)', async () => {
    const device = signedEnvelope(keys.privateKey);
    let consumed = false;
    await expect(
      authenticateTaskAssertion(
        device,
        deps({
          consume: () => {
            consumed = true;
            return Promise.resolve(true);
          },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(consumed).toBe(false);
  });

  it('refuses a task assertion presented to the device lane', async () => {
    const task = signedTaskEnvelope(keys.privateKey);
    let consumed = false;
    await expect(
      authenticateDeviceAssertion(
        task,
        deps({
          consume: () => {
            consumed = true;
            return Promise.resolve(true);
          },
        }),
      ),
    ).resolves.toBeUndefined();
    expect(consumed).toBe(false);
  });

  it('propagates replay-authority failures instead of degrading to signature-only auth', async () => {
    const envelope = signedTaskEnvelope(keys.privateKey);
    await expect(
      authenticateTaskAssertion(
        envelope,
        deps({ consume: () => Promise.reject(new Error('replay authority unavailable')) }),
      ),
    ).rejects.toThrow('replay authority unavailable');
  });

  it('AC11: one JTI is consumable once per schema, and the lanes do not occupy each other', async () => {
    // The same `jti` under both envelope kinds, against ONE shared replay
    // authority. Four outcomes, and all four matter: each lane admits its
    // first use even after the other lane already consumed that jti, and each
    // lane refuses its own second use.
    const replay = new InMemoryDeviceAssertionReplayAuthority();
    const jti = freshJti();
    const device = signedEnvelope(keys.privateKey, { jti });
    const task = signedTaskEnvelope(keys.privateKey, { jti });
    expect(device.protected.jti).toBe(task.protected.jti);

    await expect(authenticateDeviceAssertion(device, deps(replay))).resolves.toBeDefined();
    await expect(authenticateTaskAssertion(task, deps(replay))).resolves.toBeDefined();
    await expect(authenticateDeviceAssertion(device, deps(replay))).resolves.toBeUndefined();
    await expect(authenticateTaskAssertion(task, deps(replay))).resolves.toBeUndefined();
  });

  it('keys the reference ledger on the schema segment directly', async () => {
    // Same assertion over the port, not through a verifier: the discriminator
    // lives in the key, so this holds independently of which envelope produced
    // the input.
    const replay = new InMemoryDeviceAssertionReplayAuthority();
    const key = {
      tenantId: tenantId('tenant-a'),
      issuer: expected.issuer,
      productId: expected.productId,
      deviceId: 'device-1',
      audience: expected.audience,
      jti: freshJti(),
      expiresAt: '2026-08-12T04:47:00.000Z',
    } as const;
    await expect(replay.consume({ ...key, schema: DEVICE_ASSERTION_SCHEMA_ID })).resolves.toBe(true);
    await expect(replay.consume({ ...key, schema: TASK_ASSERTION_SCHEMA_ID })).resolves.toBe(true);
    await expect(replay.consume({ ...key, schema: DEVICE_ASSERTION_SCHEMA_ID })).resolves.toBe(false);
    await expect(replay.consume({ ...key, schema: TASK_ASSERTION_SCHEMA_ID })).resolves.toBe(false);
  });
});
