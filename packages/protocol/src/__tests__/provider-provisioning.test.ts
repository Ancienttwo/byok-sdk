import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_FLAGS,
  EnvelopeSchema,
  PROVIDER_PROVISIONING_CAPABILITY,
  PROVIDER_PROVISIONING_HOST_TERMINAL_CODES,
  PROVIDER_PROVISIONING_REJECTION_CODES,
  PROVIDER_SECRET_SEALING_KEY_REGISTER_OPERATION,
  ProviderProvisioningAvailablePayloadSchema,
  ProviderProvisioningCompletionSchema,
  ProviderProvisioningOperationGenerationSchema,
  ProviderProvisioningReadbackSchema,
  SERVER_TO_DAEMON_TYPES,
  createEnvelope,
  decodeEnvelope,
  encodeEnvelope,
  type ProviderProvisioningCompletion,
  type ProviderProvisioningReadback,
} from '../index';

const REQUEST_ID = '20000000-0000-4000-8000-000000000001';
const DIGEST = `sha256:${'d'.repeat(64)}`;
const OTHER_DIGEST = `sha256:${'e'.repeat(64)}`;
const BINDING = {
  profileRef: 'host-agent-1',
  profileRevision: '1759000000000',
  profileHash: `sha256:${'a'.repeat(64)}`,
  modelId: 'glm-5.3-flash',
  requiredCapabilities: [],
} as const;
const STATUS = {
  profileRef: 'host-agent-1',
  providerKind: 'zai',
  modelId: 'glm-5.3-flash',
  capabilities: [],
  secretConfigured: true,
} as const;

function applied(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    outcome: 'applied',
    requestId: REQUEST_ID,
    operation: 'configure',
    operationGeneration: '3',
    operationDigest: DIGEST,
    providerStatus: STATUS,
    binding: BINDING,
    ...overrides,
  };
}

function rejected(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    outcome: 'rejected',
    requestId: REQUEST_ID,
    operation: 'configure',
    operationGeneration: '3',
    operationDigest: DIGEST,
    code: 'seal_open_failed',
    ...overrides,
  };
}

function readback(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenantId: 'tenant-1',
    deviceId: 'device-1',
    requestId: REQUEST_ID,
    disposition: 'recorded',
    completion: applied(),
    completedAt: '2026-09-28T05:00:00.000Z',
    ...overrides,
  };
}

/**
 * Field names and values that would mean ciphertext, a configuration, or a
 * provider secret reached the notice. Every one must be rejected by the strict
 * one-field payload rather than stripped.
 */
const FORBIDDEN_NOTICE_FIELDS: Record<string, unknown> = {
  sealed: { enc: 'BASE64ENC', ct: 'BASE64CIPHERTEXT' },
  ciphertext: 'BASE64CIPHERTEXT',
  enc: 'BASE64ENC',
  ct: 'BASE64CIPHERTEXT',
  config: { operation: 'configure', providerKind: 'zai' },
  aadFields: { keyId: 'k1' },
  apiKey: 'sk-canary',
  secret: 'sk-canary',
  agentId: 'agent-1',
  operationGeneration: '3',
};

describe('provider provisioning: constants', () => {
  it('declares a product-neutral device capability and proof operation', () => {
    expect(PROVIDER_PROVISIONING_CAPABILITY).toBe('provider-provisioning.v1');
    expect(CAPABILITY_FLAGS).toContain(PROVIDER_PROVISIONING_CAPABILITY);
    expect(PROVIDER_SECRET_SEALING_KEY_REGISTER_OPERATION).toBe('provider-secret-sealing-key.register');
    for (const value of [PROVIDER_PROVISIONING_CAPABILITY, PROVIDER_SECRET_SEALING_KEY_REGISTER_OPERATION]) {
      expect(value.toLowerCase()).not.toContain('salesko');
    }
  });

  it('keeps host-terminal codes inside the closed rejection set', () => {
    for (const code of PROVIDER_PROVISIONING_HOST_TERMINAL_CODES) {
      expect(PROVIDER_PROVISIONING_REJECTION_CODES).toContain(code);
    }
    expect(new Set(PROVIDER_PROVISIONING_REJECTION_CODES).size).toBe(PROVIDER_PROVISIONING_REJECTION_CODES.length);
  });
});

describe('provider.provisioning.available notice', () => {
  it('is a server-to-daemon task-free envelope carrying exactly { requestId }', () => {
    expect(SERVER_TO_DAEMON_TYPES).toContain('provider.provisioning.available');
    const envelope = createEnvelope('provider.provisioning.available', { requestId: REQUEST_ID }, { seq: 4 });
    const decoded = decodeEnvelope(encodeEnvelope(envelope));
    expect(decoded).toEqual(envelope);
    expect(decoded.type).toBe('provider.provisioning.available');
    if (decoded.type !== 'provider.provisioning.available') throw new Error('unreachable');
    expect(Object.keys(decoded.payload)).toEqual(['requestId']);
  });

  it('forbids task_id and requires seq', () => {
    const base = {
      v: 1,
      id: '20000000-0000-4000-8000-000000000099',
      ts: '2026-09-28T05:00:00.000Z',
      type: 'provider.provisioning.available',
      seq: 1,
      payload: { requestId: REQUEST_ID },
    };
    expect(EnvelopeSchema.safeParse(base).success).toBe(true);
    expect(EnvelopeSchema.safeParse({ ...base, task_id: 'task-1' }).success).toBe(false);
    const { seq: _seq, ...withoutSeq } = base;
    expect(EnvelopeSchema.safeParse(withoutSeq).success).toBe(false);
  });

  it('requires a UUID request id', () => {
    expect(ProviderProvisioningAvailablePayloadSchema.safeParse({}).success).toBe(false);
    expect(ProviderProvisioningAvailablePayloadSchema.safeParse({ requestId: 'not-a-uuid' }).success).toBe(false);
    expect(ProviderProvisioningAvailablePayloadSchema.safeParse({ requestId: REQUEST_ID }).success).toBe(true);
  });

  it.each(Object.entries(FORBIDDEN_NOTICE_FIELDS))('rejects (never strips) an extra %s field', (field, value) => {
    const payload = { requestId: REQUEST_ID, [field]: value };
    expect(ProviderProvisioningAvailablePayloadSchema.safeParse(payload).success).toBe(false);
    const raw = JSON.stringify({
      v: 1,
      id: '20000000-0000-4000-8000-000000000098',
      ts: '2026-09-28T05:00:00.000Z',
      type: 'provider.provisioning.available',
      seq: 2,
      payload,
    });
    expect(() => decodeEnvelope(raw)).toThrow();
  });

  it('cannot be constructed with a ciphertext field', () => {
    expect(() =>
      createEnvelope(
        'provider.provisioning.available',
        { requestId: REQUEST_ID, sealed: { ct: 'x' } } as unknown as { requestId: string },
        { seq: 3 },
      ),
    ).toThrow();
  });
});

describe('provider provisioning completion', () => {
  it('accepts an applied configure with exact status and binding', () => {
    const parsed = ProviderProvisioningCompletionSchema.parse(applied());
    expect(parsed).toEqual(applied());
  });

  it('accepts an applied delete only without status and binding', () => {
    expect(
      ProviderProvisioningCompletionSchema.safeParse(applied({ operation: 'delete', providerStatus: null, binding: null })).success,
    ).toBe(true);
    expect(ProviderProvisioningCompletionSchema.safeParse(applied({ operation: 'delete' })).success).toBe(false);
    expect(ProviderProvisioningCompletionSchema.safeParse(applied({ providerStatus: null, binding: null })).success).toBe(false);
  });

  it('requires status and binding to agree on profile and model', () => {
    expect(
      ProviderProvisioningCompletionSchema.safeParse(applied({ binding: { ...BINDING, profileRef: 'host-agent-2' } })).success,
    ).toBe(false);
    expect(
      ProviderProvisioningCompletionSchema.safeParse(applied({ binding: { ...BINDING, modelId: 'other-model' } })).success,
    ).toBe(false);
  });

  it('requires a configured secret after configure and replace_secret, but reports update_model truthfully', () => {
    const noSecret = { ...STATUS, secretConfigured: false };
    expect(ProviderProvisioningCompletionSchema.safeParse(applied({ providerStatus: noSecret })).success).toBe(false);
    expect(
      ProviderProvisioningCompletionSchema.safeParse(applied({ operation: 'replace_secret', providerStatus: noSecret })).success,
    ).toBe(false);
    expect(
      ProviderProvisioningCompletionSchema.safeParse(applied({ operation: 'update_model', providerStatus: noSecret })).success,
    ).toBe(true);
  });

  it('carries operationGeneration and operationDigest on every outcome', () => {
    for (const build of [applied, rejected]) {
      for (const field of ['operationGeneration', 'operationDigest', 'operation', 'requestId']) {
        const value = build();
        delete value[field];
        expect(ProviderProvisioningCompletionSchema.safeParse(value).success, `${String(value['outcome'])} without ${field}`).toBe(false);
      }
    }
  });

  it('validates operationGeneration as canonical positive BIGINT decimal text', () => {
    for (const ok of ['1', '42', '9223372036854775807']) {
      expect(ProviderProvisioningOperationGenerationSchema.safeParse(ok).success, ok).toBe(true);
    }
    for (const bad of ['0', '01', '-1', '1.0', '9223372036854775808', '99999999999999999999', '', ' 1']) {
      expect(ProviderProvisioningOperationGenerationSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it('accepts every closed rejection code and refuses anything else', () => {
    for (const code of PROVIDER_PROVISIONING_REJECTION_CODES) {
      expect(ProviderProvisioningCompletionSchema.safeParse(rejected({ code })).success, code).toBe(true);
    }
    expect(ProviderProvisioningCompletionSchema.safeParse(rejected({ code: 'keychain said: -25300' })).success).toBe(false);
  });

  it.each([
    ['applied', applied],
    ['rejected', rejected],
  ] as const)('rejects secret-bearing or unknown fields on an %s completion', (_label, build) => {
    for (const [field, value] of Object.entries({ secret: 'sk-canary', apiKey: 'sk-canary', sealed: { ct: 'x' }, baseUrl: 'https://x', detail: 'os' })) {
      expect(ProviderProvisioningCompletionSchema.safeParse(build({ [field]: value })).success, field).toBe(false);
    }
    expect(
      ProviderProvisioningCompletionSchema.safeParse(applied({ providerStatus: { ...STATUS, baseUrl: 'https://x' } })).success,
    ).toBe(false);
    expect(
      ProviderProvisioningCompletionSchema.safeParse(applied({ providerStatus: { ...STATUS, secret: 'sk-canary' } })).success,
    ).toBe(false);
  });

  it('does not mix rejection codes into applied or status into rejected', () => {
    expect(ProviderProvisioningCompletionSchema.safeParse(applied({ code: 'seal_open_failed' })).success).toBe(false);
    expect(ProviderProvisioningCompletionSchema.safeParse(rejected({ binding: BINDING })).success).toBe(false);
  });
});

describe('provider provisioning readback', () => {
  it('accepts recorded, idempotent and conflict dispositions over the stored completion', () => {
    for (const disposition of ['recorded', 'idempotent', 'conflict'] as const) {
      const parsed: ProviderProvisioningReadback = ProviderProvisioningReadbackSchema.parse(readback({ disposition }));
      expect(parsed.disposition).toBe(disposition);
    }
    // On conflict the stored completion is returned, which may carry a different digest.
    const conflict = ProviderProvisioningReadbackSchema.parse(
      readback({ disposition: 'conflict', completion: applied({ operationDigest: OTHER_DIGEST }) }),
    );
    expect((conflict.completion as ProviderProvisioningCompletion).operationDigest).toBe(OTHER_DIGEST);
  });

  it('allows host_terminal only for host-decided rejections', () => {
    for (const code of PROVIDER_PROVISIONING_HOST_TERMINAL_CODES) {
      expect(
        ProviderProvisioningReadbackSchema.safeParse(readback({ disposition: 'host_terminal', completion: rejected({ code }) })).success,
        code,
      ).toBe(true);
    }
    expect(
      ProviderProvisioningReadbackSchema.safeParse(
        readback({ disposition: 'host_terminal', completion: rejected({ code: 'seal_open_failed' }) }),
      ).success,
    ).toBe(false);
    expect(ProviderProvisioningReadbackSchema.safeParse(readback({ disposition: 'host_terminal' })).success).toBe(false);
  });

  it('has no pending state and requires completedAt', () => {
    expect(ProviderProvisioningReadbackSchema.safeParse(readback({ disposition: 'pending' })).success).toBe(false);
    const withoutCompletedAt = readback();
    delete withoutCompletedAt['completedAt'];
    expect(ProviderProvisioningReadbackSchema.safeParse(withoutCompletedAt).success).toBe(false);
  });

  it('binds the stored completion to the readback request id', () => {
    expect(
      ProviderProvisioningReadbackSchema.safeParse(
        readback({ completion: applied({ requestId: '20000000-0000-4000-8000-000000000002' }) }),
      ).success,
    ).toBe(false);
  });

  it('rejects unknown readback fields', () => {
    expect(ProviderProvisioningReadbackSchema.safeParse(readback({ sealed: { ct: 'x' } })).success).toBe(false);
  });
});
