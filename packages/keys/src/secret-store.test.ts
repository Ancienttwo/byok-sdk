import { describe, expect, it } from 'vitest';

import { ByokKeysError } from './errors';
import {
  DEFAULT_SECRET_SERVICE_PREFIX,
  InMemorySecretStore,
  MODEL_PROVIDER_SECRET_NAMES,
  decodeStrictBase64Utf8,
  modelProviderSecretName,
} from './secret-store';

const CANARY = 'sk-canary-secret-store-0001';
const NUL = String.fromCodePoint(0);

describe('MODEL_PROVIDER_SECRET_NAMES', () => {
  it('maps every model provider id to its credential-store entry name', () => {
    expect(MODEL_PROVIDER_SECRET_NAMES).toEqual({
      anthropic: 'model-anthropic-api-key',
      custom: 'model-custom-api-key',
      deepseek: 'model-deepseek-api-key',
      openai: 'model-openai-api-key',
    });
  });

  it('exposes only names the fail-closed validator accepts', () => {
    for (const id of Object.keys(MODEL_PROVIDER_SECRET_NAMES) as (keyof typeof MODEL_PROVIDER_SECRET_NAMES)[]) {
      expect(modelProviderSecretName(id)).toBe(MODEL_PROVIDER_SECRET_NAMES[id]);
      expect(MODEL_PROVIDER_SECRET_NAMES[id]).toMatch(
        /^[a-z0-9][a-z0-9_-]{2,95}$/u,
      );
    }
  });

  it('resolves a provider id to its name', () => {
    expect(modelProviderSecretName('anthropic')).toBe('model-anthropic-api-key');
  });
});

describe('decodeStrictBase64Utf8', () => {
  it('round-trips utf-8 text including multi-byte characters', () => {
    const text = 'sk-live-余额-éà';
    const encoded = Buffer.from(text, 'utf8').toString('base64');
    expect(decodeStrictBase64Utf8(encoded)).toBe(text);
  });

  it('rejects unpadded base64 rather than silently accepting it', () => {
    expect(decodeStrictBase64Utf8('aGk')).toBeUndefined();
  });

  it('rejects non-base64 characters instead of skipping them', () => {
    // Buffer.from is lenient here and would yield "hi"; the strict decoder must not.
    expect(decodeStrictBase64Utf8('a!G@k=')).toBeUndefined();
  });

  it('rejects a payload that is not valid utf-8', () => {
    const invalidUtf8 = Buffer.from([0xff, 0xfe, 0xfd]).toString('base64');
    expect(decodeStrictBase64Utf8(invalidUtf8)).toBeUndefined();
  });

  it('rejects non-canonical padding', () => {
    expect(decodeStrictBase64Utf8('aGk==')).toBeUndefined();
  });
});

describe('InMemorySecretStore', () => {
  it('is always available', async () => {
    await expect(new InMemorySecretStore().available()).resolves.toBe(true);
  });

  it('stores and reads a secret', async () => {
    const store = new InMemorySecretStore();
    await store.set('model-openai-api-key', CANARY);
    await expect(store.get('model-openai-api-key')).resolves.toBe(CANARY);
    await expect(store.has('model-openai-api-key')).resolves.toBe(true);
  });

  it('reports an absent secret as undefined', async () => {
    const store = new InMemorySecretStore();
    await expect(store.get('model-openai-api-key')).resolves.toBeUndefined();
    await expect(store.has('model-openai-api-key')).resolves.toBe(false);
  });

  it('returns false when deleting an absent secret and true when deleting a present one', async () => {
    const store = new InMemorySecretStore();
    await expect(store.delete('model-openai-api-key')).resolves.toBe(false);
    await store.set('model-openai-api-key', CANARY);
    await expect(store.delete('model-openai-api-key')).resolves.toBe(true);
    await expect(store.get('model-openai-api-key')).resolves.toBeUndefined();
  });

  it('validates the name on every operation, failing closed', async () => {
    const store = new InMemorySecretStore();
    await expect(store.get('bad name')).rejects.toThrowError(
      expect.objectContaining({ code: 'SECRET_NAME_INVALID' }),
    );
    await expect(store.set('bad name', CANARY)).rejects.toThrowError(
      expect.objectContaining({ code: 'SECRET_NAME_INVALID' }),
    );
    await expect(store.delete('bad name')).rejects.toThrowError(
      expect.objectContaining({ code: 'SECRET_NAME_INVALID' }),
    );
  });

  it.each([
    ['empty', ''],
    ['newline', `sk-a\nb`],
    ['carriage return', `sk-a\rb`],
    ['null byte', `sk-a${NUL}b`],
  ])('rejects a %s secret value', async (_label, secret) => {
    const store = new InMemorySecretStore();
    await expect(store.set('model-openai-api-key', secret)).rejects.toThrowError(
      expect.objectContaining({ code: 'SECRET_VALUE_INVALID' }),
    );
  });

  it('throws a ByokKeysError for an invalid value', async () => {
    const store = new InMemorySecretStore();
    let thrown: unknown;
    try {
      await store.set('model-openai-api-key', '');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ByokKeysError);
  });

  it('isolates a scoped view from the unscoped store', async () => {
    const store = new InMemorySecretStore();
    const scoped = store.scope('acct_00000000');
    await store.set('model-openai-api-key', 'unscoped');
    await scoped.set('model-openai-api-key', 'scoped');
    await expect(store.get('model-openai-api-key')).resolves.toBe('unscoped');
    await expect(scoped.get('model-openai-api-key')).resolves.toBe('scoped');
  });

  it('isolates two sibling scopes from each other', async () => {
    const store = new InMemorySecretStore();
    const left = store.scope('acct_11111111');
    const right = store.scope('acct_22222222');
    await left.set('model-openai-api-key', 'left');
    await right.set('model-openai-api-key', 'right');
    await expect(left.get('model-openai-api-key')).resolves.toBe('left');
    await expect(right.get('model-openai-api-key')).resolves.toBe('right');
    await expect(left.delete('model-openai-api-key')).resolves.toBe(true);
    await expect(right.get('model-openai-api-key')).resolves.toBe('right');
  });

  it('nests scopes', async () => {
    const store = new InMemorySecretStore();
    const nested = store.scope('acct_00000000').scope('workspace0');
    await nested.set('model-openai-api-key', 'nested');
    await expect(store.get('model-openai-api-key')).resolves.toBeUndefined();
    await expect(nested.get('model-openai-api-key')).resolves.toBe('nested');
  });

  it('validates the namespace when scoping, failing closed', () => {
    const store = new InMemorySecretStore();
    expect(() => store.scope('short')).toThrowError(
      expect.objectContaining({ code: 'SECRET_NAMESPACE_INVALID' }),
    );
  });

  it('keys entries by the same service string shape the OS backends use', async () => {
    const entries = new Map<string, string>();
    const store = new InMemorySecretStore({ entries });
    await store.set('model-openai-api-key', CANARY);
    expect([...entries.keys()]).toEqual([
      `${DEFAULT_SECRET_SERVICE_PREFIX}.model-openai-api-key`,
    ]);
    await store.scope('acct_00000000').set('model-openai-api-key', 'scoped');
    expect([...entries.keys()]).toContain(
      `${DEFAULT_SECRET_SERVICE_PREFIX}.scope.acct_00000000.model-openai-api-key`,
    );
  });

  it('labels itself so a caller can tell it apart from an OS backend', () => {
    expect(new InMemorySecretStore().providerLabel).toBe('in-memory');
  });
});
