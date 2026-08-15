/**
 * Device proof canonicalization (§12.6.3, sprint §S6.2).
 *
 * A signature is only as stable as the bytes it covers. This file pins those
 * bytes three ways:
 *
 * 1. **A golden fixture** — `golden/device-proof-v1.canonical.json` holds the
 *    canonical JSON, the prefixed UTF-8 string, and its hex, so any drift in
 *    the canonicalizer shows up as a diff rather than as signatures that stop
 *    verifying in production. It lives here, not in the protocol golden: the
 *    proof envelope is not part of the frozen v1 wire.
 *    Regenerate deliberately with
 *    `BYOK_CORE_UPDATE_GOLDEN=1 bun run --filter @byok-sdk/core test`, and treat any
 *    resulting diff as a breaking change to the signing format.
 * 2. **Insertion-order permutation** — the same claims built in scrambled key
 *    order must produce byte-identical output. This is the falsifier the plan
 *    names: without it the golden proves nothing, because a canonicalizer that
 *    just serializes in insertion order would pass a single fixture.
 * 3. **Fail-closed negatives** — floats, non-safe integers, `NaN`, `Infinity`,
 *    `undefined`, `bigint`, dates, class instances and cycles throw instead of
 *    being coerced into some implementation's default rendering.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEVICE_PROOF_DOMAIN_PREFIX,
  DEVICE_PROOF_SCHEMA_ID,
  DeviceProofProtectedClaimsSchema,
  canonicalizeJson,
  deviceProofCanonicalClaims,
  deviceProofCanonicalJson,
  deviceProofSigningInput,
  parseDeviceProofEnvelope,
  type DeviceProofProtectedClaims,
  type JsonValue,
} from '../attestation';
import { isCoreError } from '../errors';

const GOLDEN_URL = new URL('./golden/device-proof-v1.canonical.json', import.meta.url);

const BODY_HASH = `sha256:${'ab'.repeat(32)}`;
const OTHER_HASH = `sha256:${'cd'.repeat(32)}`;

/** The claim sets the golden pins. Extending this list is an additive change. */
const GOLDEN_INPUTS: readonly { readonly name: string; readonly claims: unknown }[] = [
  {
    name: 'method and path binding, no optional claims',
    claims: {
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
      bodySha256: BODY_HASH,
      bodySize: 1024,
      issuedAt: '2026-08-07T10:00:00.000Z',
    },
  },
  {
    name: 'operation id binding with expiry and nonce',
    claims: {
      version: 1,
      tenantId: 'tenant-b',
      productId: 'product-b',
      deviceId: 'device-2',
      keyId: 'key-2',
      keyEpoch: 7,
      requestId: 'req-2',
      operation: 'storage.reserve',
      resource: 'reservation/res-1',
      operationId: 'storage.createReservation',
      bodySha256: OTHER_HASH,
      bodySize: 0,
      issuedAt: '2026-08-07T10:00:00.000Z',
      expiresAt: '2026-08-07T10:05:00.000Z',
      nonce: 'n-abc',
    },
  },
  {
    name: 'non-ascii resource and operation',
    claims: {
      version: 1,
      tenantId: 'tenant-c',
      productId: '产品-c',
      deviceId: 'device-3',
      keyId: 'key-3',
      keyEpoch: 1,
      requestId: 'req-3',
      operation: 'memory.write',
      resource: 'memory/笔记\u0000/"quoted"',
      method: 'POST',
      path: '/byok/records/memory/notes',
      bodySha256: BODY_HASH,
      bodySize: 9007199254740991,
      issuedAt: '2026-08-07T10:00:00.000Z',
    },
  },
];

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function parseClaims(input: unknown): DeviceProofProtectedClaims {
  return DeviceProofProtectedClaimsSchema.parse(input);
}

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
    schema: DEVICE_PROOF_SCHEMA_ID,
    domainPrefix: DEVICE_PROOF_DOMAIN_PREFIX,
    note: 'Canonical signing bytes for byok-device-proof-v1. Regenerate with BYOK_CORE_UPDATE_GOLDEN=1 bun run --filter @byok-sdk/core test, and treat any diff as a breaking change to the signature format.',
    cases: GOLDEN_INPUTS.map((input) => {
      const claims = parseClaims(input.claims);
      const bytes = deviceProofSigningInput(claims);
      return {
        name: input.name,
        claims: input.claims,
        canonicalJson: deviceProofCanonicalJson(claims),
        signingInputUtf8: DEVICE_PROOF_DOMAIN_PREFIX + deviceProofCanonicalJson(claims),
        signingInputHex: toHex(bytes),
      };
    }),
  };
}

if (process.env['BYOK_CORE_UPDATE_GOLDEN'] === '1') {
  writeFileSync(GOLDEN_URL, `${JSON.stringify(buildGolden(), null, 2)}\n`, 'utf8');
}

const golden = JSON.parse(readFileSync(GOLDEN_URL, 'utf8')) as GoldenFile;

describe('device proof golden', () => {
  it('covers every pinned claim set', () => {
    expect(golden.cases.map((entry) => entry.name)).toEqual(
      GOLDEN_INPUTS.map((input) => input.name),
    );
    expect(golden.domainPrefix).toBe('byok-device-proof-v1\n');
  });

  for (const [index, input] of GOLDEN_INPUTS.entries()) {
    it(`reproduces the frozen bytes: ${input.name}`, () => {
      const expected = golden.cases[index]!;
      const claims = parseClaims(input.claims);

      expect(deviceProofCanonicalJson(claims)).toBe(expected.canonicalJson);
      expect(toHex(deviceProofSigningInput(claims))).toBe(expected.signingInputHex);
      expect(expected.signingInputUtf8.startsWith(DEVICE_PROOF_DOMAIN_PREFIX)).toBe(true);
      expect(expected.signingInputUtf8).toBe(
        DEVICE_PROOF_DOMAIN_PREFIX + expected.canonicalJson,
      );
    });
  }
});

describe('canonicalizer determinism', () => {
  it('is invariant under claim key insertion order', () => {
    for (const input of GOLDEN_INPUTS) {
      const entries = Object.entries(input.claims as Record<string, unknown>);
      const reversed = Object.fromEntries([...entries].reverse());
      const rotated = Object.fromEntries([...entries.slice(3), ...entries.slice(0, 3)]);

      const baseline = toHex(deviceProofSigningInput(parseClaims(input.claims)));
      expect(toHex(deviceProofSigningInput(parseClaims(reversed)))).toBe(baseline);
      expect(toHex(deviceProofSigningInput(parseClaims(rotated)))).toBe(baseline);
    }
  });

  it('is invariant under nested key insertion order', () => {
    const first = { outer: { b: 1, a: [{ y: true, x: null }] }, alpha: 'a' };
    const second = { alpha: 'a', outer: { a: [{ x: null, y: true }], b: 1 } };
    expect(canonicalizeJson(second as JsonValue)).toBe(canonicalizeJson(first as JsonValue));
    expect(canonicalizeJson(first as JsonValue)).toBe(
      '{"alpha":"a","outer":{"a":[{"x":null,"y":true}],"b":1}}',
    );
  });

  it('sorts object keys by UTF-16 code unit, not by locale', () => {
    // A locale-aware sort would order these differently; RFC 8785 does not.
    expect(canonicalizeJson({ b: 1, A: 2, a: 3, B: 4 } as JsonValue)).toBe(
      '{"A":2,"B":4,"a":3,"b":1}',
    );
  });

  it('omits an absent optional claim rather than encoding it as a key', () => {
    const withoutNonce = parseClaims(GOLDEN_INPUTS[0]!.claims);
    expect(deviceProofCanonicalJson(withoutNonce)).not.toContain('nonce');
    expect(Object.keys(deviceProofCanonicalClaims(withoutNonce))).not.toContain('nonce');
  });
});

describe('canonicalizer fail-closed behavior', () => {
  const rejected: readonly (readonly [string, unknown])[] = [
    ['float', { a: 1.5 }],
    ['negative float', { a: -0.1 }],
    ['unsafe integer', { a: Number.MAX_SAFE_INTEGER + 2 }],
    ['NaN', { a: Number.NaN }],
    ['Infinity', { a: Number.POSITIVE_INFINITY }],
    ['undefined value', { a: undefined }],
    ['undefined array element', { a: [1, undefined] }],
    ['bigint', { a: 1n }],
    ['Date', { a: new Date('2026-01-01T00:00:00.000Z') }],
    ['Map', { a: new Map() }],
    ['function', { a: () => 1 }],
    ['symbol', { a: Symbol('s') }],
  ];

  for (const [name, value] of rejected) {
    it(`refuses ${name}`, () => {
      const error = (() => {
        try {
          canonicalizeJson(value as JsonValue);
          return undefined;
        } catch (caught: unknown) {
          return caught;
        }
      })();
      expect(isCoreError(error, 'proof_canonicalization_failed')).toBe(true);
    });
  }

  it('refuses a circular structure', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    expect(() => canonicalizeJson(cyclic as JsonValue)).toThrow(/circular/);
  });

  it('accepts the full admitted value space', () => {
    expect(
      canonicalizeJson({
        s: 'text',
        t: true,
        f: false,
        n: null,
        i: -42,
        z: 0,
        max: Number.MAX_SAFE_INTEGER,
        arr: [1, 'two', false, null, { k: 'v' }],
        obj: {},
      } as JsonValue),
    ).toBe(
      '{"arr":[1,"two",false,null,{"k":"v"}],"f":false,"i":-42,"max":9007199254740991,"n":null,"obj":{},"s":"text","t":true,"z":0}',
    );
  });

  it('normalizes negative zero', () => {
    expect(canonicalizeJson({ a: -0 } as JsonValue)).toBe('{"a":0}');
  });
});

describe('protected claims schema', () => {
  const base = GOLDEN_INPUTS[0]!.claims as Record<string, unknown>;

  it('requires exactly one request binding', () => {
    const { method, path, ...withoutBinding } = base;
    void method;
    void path;
    expect(DeviceProofProtectedClaimsSchema.safeParse(withoutBinding).success).toBe(false);
    expect(
      DeviceProofProtectedClaimsSchema.safeParse({
        ...base,
        operationId: 'storage.createReservation',
      }).success,
    ).toBe(false);
    expect(
      DeviceProofProtectedClaimsSchema.safeParse({ ...withoutBinding, method: 'PUT' }).success,
    ).toBe(false);
  });

  it('binds the body by hash and size, both required', () => {
    const { bodySha256, ...withoutHash } = base;
    void bodySha256;
    const { bodySize, ...withoutSize } = base;
    void bodySize;
    expect(DeviceProofProtectedClaimsSchema.safeParse(withoutHash).success).toBe(false);
    expect(DeviceProofProtectedClaimsSchema.safeParse(withoutSize).success).toBe(false);
    expect(
      DeviceProofProtectedClaimsSchema.safeParse({ ...base, bodySha256: 'deadbeef' }).success,
    ).toBe(false);
  });

  it('rejects unknown claims and non-UTC timestamps', () => {
    expect(
      DeviceProofProtectedClaimsSchema.safeParse({ ...base, extra: 'smuggled' }).success,
    ).toBe(false);
    expect(
      DeviceProofProtectedClaimsSchema.safeParse({
        ...base,
        issuedAt: '2026-08-07T10:00:00+08:00',
      }).success,
    ).toBe(false);
  });

  it('rejects a fractional body size', () => {
    expect(DeviceProofProtectedClaimsSchema.safeParse({ ...base, bodySize: 1.5 }).success).toBe(
      false,
    );
  });
});

describe('envelope', () => {
  const envelope = {
    schema: DEVICE_PROOF_SCHEMA_ID,
    algorithm: 'ed25519',
    protected: GOLDEN_INPUTS[0]!.claims,
    signature: 'c2lnbmF0dXJl',
  };

  it('parses a well-formed envelope', () => {
    const parsed = parseDeviceProofEnvelope(envelope);
    expect(parsed.protected.tenantId).toBe('tenant-a');
    expect(parsed.algorithm).toBe('ed25519');
  });

  it('fails closed on an unknown algorithm, a padded signature, and a wrong schema id', () => {
    for (const broken of [
      { ...envelope, algorithm: 'hmac-sha256' },
      { ...envelope, signature: 'c2lnbmF0dXJl==' },
      { ...envelope, schema: 'byok-device-proof-v2' },
      { ...envelope, extra: true },
    ]) {
      const error = (() => {
        try {
          parseDeviceProofEnvelope(broken);
          return undefined;
        } catch (caught: unknown) {
          return caught;
        }
      })();
      expect(isCoreError(error, 'proof_envelope_invalid')).toBe(true);
    }
  });
});
