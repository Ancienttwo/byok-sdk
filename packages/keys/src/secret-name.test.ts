import { describe, expect, it } from 'vitest';

import { ByokKeysError } from './errors';
import { assertSecretName, assertSecretNamespace } from './secret-name';

const NUL = String.fromCodePoint(0);

describe('assertSecretName', () => {
  it('returns the name unchanged when it is legal', () => {
    expect(assertSecretName('model-openai-api-key')).toBe(
      'model-openai-api-key',
    );
  });

  it('accepts underscores and digits', () => {
    expect(assertSecretName('model_2_api_key')).toBe('model_2_api_key');
  });

  it('rejects a dot, which would let a name forge another scope service string', () => {
    let thrown: unknown;
    try {
      assertSecretName('scope.acct_abcdefgh.model-openai-api-key');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ByokKeysError);
    expect((thrown as ByokKeysError).code).toBe('SECRET_NAME_INVALID');
  });

  it.each([
    ['empty', ''],
    ['too short', 'ab'],
    ['leading dash', '-model-key'],
    ['uppercase', 'Model-Key'],
    ['inner whitespace', 'model key'],
    ['newline', 'model\nkey'],
    ['carriage return', 'model\rkey'],
    ['null byte', `model${NUL}key`],
    ['slash', 'model/key'],
    ['97 characters', `a${'b'.repeat(96)}`],
  ])('rejects %s', (_label, value) => {
    expect(() => assertSecretName(value)).toThrowError(
      expect.objectContaining({ code: 'SECRET_NAME_INVALID' }),
    );
  });

  it('accepts exactly 96 characters', () => {
    const name = `a${'b'.repeat(95)}`;
    expect(assertSecretName(name)).toBe(name);
  });

  it('does not trim: a padded name is rejected rather than sanitized', () => {
    expect(() => assertSecretName(' model-openai-api-key ')).toThrowError(
      expect.objectContaining({ code: 'SECRET_NAME_INVALID' }),
    );
  });
});

describe('assertSecretNamespace', () => {
  it('returns a trimmed namespace of legal length', () => {
    expect(assertSecretNamespace('  acct_00000000  ')).toBe('acct_00000000');
  });

  it('accepts a scope id shaped like sha-256 hex', () => {
    const scopeId = `acct_${'a'.repeat(64)}`;
    expect(assertSecretNamespace(scopeId)).toBe(scopeId);
  });

  it.each([
    ['shorter than eight characters', 'acct_00'],
    ['uppercase', 'ACCT_00000000'],
    ['a dot', 'acct.00000000'],
    ['a slash', 'acct/00000000'],
    ['97 characters', `a${'b'.repeat(96)}`],
  ])('rejects %s', (_label, value) => {
    expect(() => assertSecretNamespace(value)).toThrowError(
      expect.objectContaining({ code: 'SECRET_NAMESPACE_INVALID' }),
    );
  });
});
