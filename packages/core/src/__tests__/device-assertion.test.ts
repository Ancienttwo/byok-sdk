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
  deviceAssertionCanonicalClaims,
  deviceAssertionCanonicalJson,
  deviceAssertionSigningInput,
  parseDeviceAssertionEnvelope,
  verifyDeviceAssertion,
  type DeviceAssertionClaims,
  type DeviceAssertionEnvelopeV1,
  type DeviceAssertionVerifier,
} from '../device-assertion';
import { DEVICE_PROOF_DOMAIN_PREFIX, deviceProofSigningInput, DeviceProofProtectedClaimsSchema } from '../attestation';
import { isCoreError } from '../errors';

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
  ];

  it('keeps the two core-owned prefixes distinct and non-prefix', () => {
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
