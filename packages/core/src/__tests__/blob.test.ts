/**
 * The object-key layout contract.
 *
 * `tenantObjectKey` is the single authority for where an object lives, and a
 * deployment's existing objects are addressable only for as long as it keeps
 * producing the same bytes for the same inputs. The default-layout assertion
 * below is therefore written as a literal, not as a re-derivation of the
 * implementation: a test that rebuilds the key from the same template it is
 * checking cannot notice the template changing.
 */
import { describe, expect, it } from 'vitest';
import { contentHash, objectKeyPrefix, tenantObjectKey } from '../blob';
import { ByokCoreError } from '../errors';
import { tenantId } from '../tenant';

const TENANT = tenantId('acme');
const HEX = 'ab'.repeat(32);
const HASH = contentHash(`sha256:${HEX}`);
const DEFAULT_KEY = `tenants/acme/objects/sha256/${HEX}`;

describe('tenantObjectKey default layout', () => {
  it('is byte-for-byte the layout every existing deployment already stores', () => {
    expect(tenantObjectKey(TENANT, HASH)).toBe(DEFAULT_KEY);
  });

  it('is the same key whether the prefix is omitted or passed as undefined', () => {
    expect(tenantObjectKey(TENANT, HASH, undefined)).toBe(DEFAULT_KEY);
  });
});

describe('tenantObjectKey with a prefix', () => {
  it('namespaces the layout without reshaping anything under it', () => {
    expect(tenantObjectKey(TENANT, HASH, objectKeyPrefix('acme/prod'))).toBe(
      `acme/prod/${DEFAULT_KEY}`,
    );
    expect(tenantObjectKey(TENANT, HASH, objectKeyPrefix('salesko'))).toBe(
      `salesko/${DEFAULT_KEY}`,
    );
  });

  it('keeps two prefixes disjoint even when one is a string prefix of the other', () => {
    // `acme` and `acme-2` share leading characters; the joining slash is what
    // stops a ListObjectsV2 scan of one from also matching the other.
    const narrow = tenantObjectKey(TENANT, HASH, objectKeyPrefix('acme'));
    const wide = tenantObjectKey(TENANT, HASH, objectKeyPrefix('acme-2'));
    expect(wide.startsWith('acme/')).toBe(false);
    expect(narrow.startsWith('acme/')).toBe(true);
  });
});

describe('objectKeyPrefix', () => {
  it('accepts slash-joined lowercase segments', () => {
    for (const value of ['a', '0', 'acme', 'acme/prod', 'a.b-c_d/9/x']) {
      expect(objectKeyPrefix(value)).toBe(value);
    }
  });

  it('fails closed on anything that would not reach the object store verbatim', () => {
    const rejected = [
      '',
      '/',
      '/acme',
      'acme/',
      'acme//prod',
      'Acme',
      'acme prod',
      '.acme',
      '-acme',
      'acme%2fprod',
      'acme/../prod',
      'acme\\prod',
      'éacme',
    ];

    for (const value of rejected) {
      let caught: unknown;
      try {
        objectKeyPrefix(value);
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught, `expected ${JSON.stringify(value)} to be refused`).toBeInstanceOf(
        ByokCoreError,
      );
      expect((caught as ByokCoreError).code).toBe('object_key_prefix_invalid');
    }
  });
});
