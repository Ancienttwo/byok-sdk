import { beforeEach, describe, expect, it } from 'vitest';

import { ByokKeysError } from './errors';
import {
  DEFAULT_SECRET_ENVELOPE_PREFIX,
  EnvelopeScopedSecretStore,
  scopeSecretStore,
  secretScopeId,
} from './secret-scope';
import { InMemorySecretStore } from './secret-store';

const CANARY = 'sk-canary-scope-0001';
const NAME = 'model-openai-api-key';
const SCOPE = { account_id: 'acct-1', workspace_id: 'ws-1' } as const;

describe('secretScopeId', () => {
  it('produces a stable acct_-prefixed sha-256 hex id', () => {
    const id = secretScopeId(SCOPE);
    expect(id).toMatch(/^acct_[0-9a-f]{64}$/u);
    expect(secretScopeId(SCOPE)).toBe(id);
  });

  it('separates the account and workspace components', () => {
    expect(
      secretScopeId({ account_id: 'a', workspace_id: 'b' }),
    ).not.toBe(secretScopeId({ account_id: 'b', workspace_id: 'a' }));
  });

  it('trims its inputs', () => {
    expect(
      secretScopeId({ account_id: '  acct-1  ', workspace_id: '  ws-1  ' }),
    ).toBe(secretScopeId(SCOPE));
  });

  it('emits an id the namespace validator accepts', () => {
    expect(secretScopeId(SCOPE)).toMatch(/^[a-z0-9][a-z0-9_-]{7,95}$/u);
  });

  it.each([
    ['an empty account', { account_id: '', workspace_id: 'ws-1' }],
    ['a blank account', { account_id: '   ', workspace_id: 'ws-1' }],
    ['an empty workspace', { account_id: 'acct-1', workspace_id: '' }],
    [
      'an over-long account',
      { account_id: 'a'.repeat(161), workspace_id: 'ws-1' },
    ],
    [
      'an over-long workspace',
      { account_id: 'acct-1', workspace_id: 'w'.repeat(161) },
    ],
  ])('rejects %s', (_label, scope) => {
    expect(() => secretScopeId(scope)).toThrowError(
      expect.objectContaining({ code: 'LOCAL_ACCOUNT_SCOPE_INVALID' }),
    );
  });

  it('rejects a newline, which would let two different scopes hash identically', () => {
    // "a\nb" + "c" and "a" + "b\nc" both serialize to "a\nb\nc".
    expect(() =>
      secretScopeId({ account_id: 'a\nb', workspace_id: 'c' }),
    ).toThrowError(
      expect.objectContaining({ code: 'LOCAL_ACCOUNT_SCOPE_INVALID' }),
    );
    expect(() =>
      secretScopeId({ account_id: 'a', workspace_id: 'b\nc' }),
    ).toThrowError(
      expect.objectContaining({ code: 'LOCAL_ACCOUNT_SCOPE_INVALID' }),
    );
  });
});

describe('scopeSecretStore', () => {
  it('delegates to the store\'s required scope() with the derived id', async () => {
    const store = new InMemorySecretStore();
    const scoped = scopeSecretStore(store, SCOPE);
    await scoped.set(NAME, CANARY);
    await expect(store.get(NAME)).resolves.toBeUndefined();
    await expect(store.scope(secretScopeId(SCOPE)).get(NAME)).resolves.toBe(
      CANARY,
    );
  });

  it('gives two different scopes two different views', async () => {
    const store = new InMemorySecretStore();
    const left = scopeSecretStore(store, SCOPE);
    const right = scopeSecretStore(store, {
      account_id: 'acct-2',
      workspace_id: 'ws-1',
    });
    await left.set(NAME, 'left');
    await right.set(NAME, 'right');
    await expect(left.get(NAME)).resolves.toBe('left');
    await expect(right.get(NAME)).resolves.toBe('right');
  });
});

describe('EnvelopeScopedSecretStore', () => {
  let backing: InMemorySecretStore;

  const envelope = (scopeId: string) =>
    new EnvelopeScopedSecretStore(backing, scopeId);

  beforeEach(() => {
    backing = new InMemorySecretStore();
  });

  it('round-trips a secret through a single underlying entry', async () => {
    const scoped = envelope('acct_00000000');
    await scoped.set(NAME, CANARY);
    await expect(scoped.get(NAME)).resolves.toBe(CANARY);
    await expect(scoped.has(NAME)).resolves.toBe(true);
  });

  it('stores the envelope, not the bare secret', async () => {
    const scoped = envelope('acct_00000000');
    await scoped.set(NAME, CANARY);
    const stored = await backing.get(NAME);
    expect(stored?.startsWith(DEFAULT_SECRET_ENVELOPE_PREFIX)).toBe(true);
    expect(stored).not.toContain(CANARY);
  });

  it('keeps two scopes isolated inside one underlying entry', async () => {
    const left = envelope('acct_11111111');
    const right = envelope('acct_22222222');
    await left.set(NAME, 'left');
    await right.set(NAME, 'right');
    await expect(left.get(NAME)).resolves.toBe('left');
    await expect(right.get(NAME)).resolves.toBe('right');
    expect(await backing.has(NAME)).toBe(true);
  });

  it('reports an absent underlying entry as an absent secret', async () => {
    await expect(envelope('acct_00000000').get(NAME)).resolves.toBeUndefined();
    await expect(envelope('acct_00000000').has(NAME)).resolves.toBe(false);
  });

  it('deletes only its own slot, leaving siblings intact', async () => {
    const left = envelope('acct_11111111');
    const right = envelope('acct_22222222');
    await left.set(NAME, 'left');
    await right.set(NAME, 'right');
    await expect(left.delete(NAME)).resolves.toBe(true);
    await expect(left.get(NAME)).resolves.toBeUndefined();
    await expect(right.get(NAME)).resolves.toBe('right');
  });

  it('removes the underlying entry once the last slot is deleted', async () => {
    const scoped = envelope('acct_00000000');
    await scoped.set(NAME, CANARY);
    await expect(scoped.delete(NAME)).resolves.toBe(true);
    await expect(backing.has(NAME)).resolves.toBe(false);
  });

  it('returns false when the underlying entry is absent', async () => {
    await expect(envelope('acct_00000000').delete(NAME)).resolves.toBe(false);
  });

  it('returns false when the envelope has no slot for this scope', async () => {
    await envelope('acct_11111111').set(NAME, 'left');
    await expect(envelope('acct_22222222').delete(NAME)).resolves.toBe(false);
  });

  it('fails closed when the underlying value is not an envelope', async () => {
    await backing.set(NAME, CANARY);
    let thrown: unknown;
    try {
      await envelope('acct_00000000').get(NAME);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ByokKeysError);
    expect((thrown as ByokKeysError).code).toBe('SECRET_ENVELOPE_INVALID');
  });

  it('does not overwrite a foreign underlying value on set', async () => {
    await backing.set(NAME, CANARY);
    await expect(envelope('acct_00000000').set(NAME, 'new')).rejects.toThrowError(
      expect.objectContaining({ code: 'SECRET_ENVELOPE_INVALID' }),
    );
    await expect(backing.get(NAME)).resolves.toBe(CANARY);
  });

  it.each([
    ['a non-base64url payload', 'not!base64url!'],
    ['a payload that is not JSON', Buffer.from('nope', 'utf8').toString('base64url')],
    ['a JSON array', Buffer.from('["a"]', 'utf8').toString('base64url')],
    ['a JSON string', Buffer.from('"a"', 'utf8').toString('base64url')],
    [
      'an object with a non-string value',
      Buffer.from('{"acct_00000000":1}', 'utf8').toString('base64url'),
    ],
  ])('fails closed on %s', async (_label, payload) => {
    await backing.set(NAME, `${DEFAULT_SECRET_ENVELOPE_PREFIX}${payload}`);
    await expect(envelope('acct_00000000').get(NAME)).rejects.toThrowError(
      expect.objectContaining({ code: 'SECRET_ENVELOPE_INVALID' }),
    );
  });

  it('validates the secret value', async () => {
    await expect(envelope('acct_00000000').set(NAME, '')).rejects.toThrowError(
      expect.objectContaining({ code: 'SECRET_VALUE_INVALID' }),
    );
  });

  it('validates the secret name', async () => {
    await expect(
      envelope('acct_00000000').get('bad name'),
    ).rejects.toThrowError(
      expect.objectContaining({ code: 'SECRET_NAME_INVALID' }),
    );
  });

  it('validates its scope id', () => {
    expect(() => envelope('short')).toThrowError(
      expect.objectContaining({ code: 'SECRET_NAMESPACE_INVALID' }),
    );
  });

  it('nests scopes by extending the slot key', async () => {
    const nested = envelope('acct_00000000').scope('workspace0');
    await nested.set(NAME, 'nested');
    await expect(nested.get(NAME)).resolves.toBe('nested');
    await expect(envelope('acct_00000000').get(NAME)).resolves.toBeUndefined();
  });

  it('does not resolve a scope id that names an Object.prototype member', async () => {
    // `constructor` is a legal namespace, so a caller can hold this scope. A
    // plain-object envelope would answer the lookup from the prototype chain
    // and report a Function as this scope's secret.
    await envelope('acct_11111111').set(NAME, 'left');
    const proto = envelope('constructor');
    await expect(proto.get(NAME)).resolves.toBeUndefined();
    await expect(proto.has(NAME)).resolves.toBe(false);
    await expect(proto.delete(NAME)).resolves.toBe(false);
    await expect(envelope('acct_11111111').get(NAME)).resolves.toBe('left');
  });

  it('still isolates a prototype-named scope once it holds a secret', async () => {
    await envelope('acct_11111111').set(NAME, 'left');
    const proto = envelope('constructor');
    await proto.set(NAME, CANARY);
    await expect(proto.get(NAME)).resolves.toBe(CANARY);
    await expect(proto.has(NAME)).resolves.toBe(true);
    await expect(envelope('acct_11111111').get(NAME)).resolves.toBe('left');
    await expect(proto.delete(NAME)).resolves.toBe(true);
    await expect(proto.get(NAME)).resolves.toBeUndefined();
    await expect(envelope('acct_11111111').get(NAME)).resolves.toBe('left');
  });

  it('mirrors the wrapped store label and availability', async () => {
    const scoped = envelope('acct_00000000');
    expect(scoped.providerLabel).toBe(backing.providerLabel);
    await expect(scoped.available()).resolves.toBe(true);
  });

  it('honours an injected envelope prefix', async () => {
    const scoped = new EnvelopeScopedSecretStore(backing, 'acct_00000000', {
      envelopePrefix: 'aiphabee-scoped-secrets-v1:',
    });
    await scoped.set(NAME, CANARY);
    const stored = await backing.get(NAME);
    expect(stored?.startsWith('aiphabee-scoped-secrets-v1:')).toBe(true);
    await expect(scoped.get(NAME)).resolves.toBe(CANARY);
  });
});
