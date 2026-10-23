/**
 * #654 §9.2: the comparison projection of a sealed submission. Every field of
 * the sealed member is either compared or dropped as a reseal field. A new
 * field of the schema fails the first test until it is classified here and in
 * `sealed-comparison.ts`.
 */
import { SealedTaskInputSchema } from '@byok-sdk/protocol';
import { describe, expect, it } from 'vitest';
import { sameSealedProjection } from '../sealed-comparison';

const COMPARED = ['v', 'suite', 'category', 'scope', 'paddedLength', 'contentMac'] as const;
const RESEALED = ['chainHead', 'sender', 'salt', 'nonce', 'ciphertext', 'ciphertextRef'] as const;

const FIRST = {
  runtime: 'pi',
  workspaceHint: 'repo-a',
  sealing: { scopeId: 'scope-a', epoch: 1, categories: ['task-input'] },
  sealed: {
    v: 1,
    suite: 'suite-a',
    category: 'task-input',
    scope: { id: 'scope-a', epoch: 1, keyId: 'key-a' },
    chainHead: { seq: 1, hash: 'hash-a' },
    sender: 'sender-a',
    salt: 'salt-a',
    nonce: 'nonce-a',
    paddedLength: 1024,
    contentMac: 'mac-a',
    ciphertext: 'ciphertext-a',
  },
};

function withSealed(field: string): object {
  return { ...FIRST, sealed: { ...FIRST.sealed, [field]: 'changed' } };
}

describe('the comparison projection of a sealed submission (#654 §9.2)', () => {
  it('classifies every field of the sealed member schema', () => {
    expect([...COMPARED, ...RESEALED].sort()).toEqual(Object.keys(SealedTaskInputSchema.shape).sort());
  });

  it.each(COMPARED)('a change of sealed.%s is other content', (field) => {
    expect(sameSealedProjection(FIRST, withSealed(field))).toBe(false);
  });

  it.each(RESEALED)('a change of sealed.%s is the same content sealed again', (field) => {
    expect(sameSealedProjection(FIRST, withSealed(field))).toBe(true);
  });

  it.each(['runtime', 'workspaceHint', 'sealing'])('a change of the plaintext field %s is other content', (field) => {
    expect(sameSealedProjection(FIRST, { ...FIRST, [field]: 'changed' })).toBe(false);
  });
});
