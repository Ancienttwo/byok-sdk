/**
 * The mint point (§12.6.2 layer 1).
 *
 * The branding is compile-time only, so the runtime half of the guarantee is
 * entirely in `tenantId()`: if it accepts a value the control plane would not
 * recognize as an id, the type system's promise is hollow.
 */
import { describe, expect, it } from 'vitest';
import { isCoreError } from '../errors';
import {
  TENANT_ID_MAX_LENGTH,
  TENANT_KEY_SEPARATOR,
  isTenantId,
  tenantId,
  tenantKey,
} from '../tenant';

describe('tenantId', () => {
  it('mints a value that is still a string at runtime', () => {
    const tenant = tenantId('tenant-a');
    expect(tenant).toBe('tenant-a');
    expect(typeof tenant).toBe('string');
  });

  it('rejects empty, padded, over-long, and NUL-bearing ids', () => {
    const rejected = [
      '',
      ' ',
      ' tenant-a',
      'tenant-a ',
      '\ttenant-a',
      'a'.repeat(TENANT_ID_MAX_LENGTH + 1),
      `tenant${TENANT_KEY_SEPARATOR}a`,
    ];
    for (const value of rejected) {
      const error = (() => {
        try {
          tenantId(value);
          return undefined;
        } catch (caught: unknown) {
          return caught;
        }
      })();
      expect(isCoreError(error, 'tenant_id_invalid'), `expected ${JSON.stringify(value)} to be rejected`).toBe(true);
    }
  });

  it('accepts the boundary length', () => {
    expect(tenantId('a'.repeat(TENANT_ID_MAX_LENGTH))).toHaveLength(TENANT_ID_MAX_LENGTH);
  });

  it('does not normalize', () => {
    // Two ids that differ only in case stay two ids: the control plane owns the
    // canonical form, and folding here would make the SDK disagree with it.
    expect(tenantId('Tenant-A')).not.toBe(tenantId('tenant-a'));
  });

  it('agrees with isTenantId on every input', () => {
    const candidates: unknown[] = [
      'tenant-a',
      '',
      ' tenant-a',
      'a'.repeat(TENANT_ID_MAX_LENGTH),
      'a'.repeat(TENANT_ID_MAX_LENGTH + 1),
      `tenant${TENANT_KEY_SEPARATOR}a`,
      42,
      null,
      undefined,
      {},
    ];
    for (const candidate of candidates) {
      const minted = (() => {
        try {
          tenantId(candidate as string);
          return true;
        } catch {
          return false;
        }
      })();
      expect(isTenantId(candidate), `disagreement on ${String(candidate)}`).toBe(minted);
    }
  });
});

describe('tenantKey', () => {
  it('cannot produce an ambiguous composite key', () => {
    const a = tenantKey(tenantId('a'), 'bc');
    const b = tenantKey(tenantId('ab'), 'c');
    expect(a).not.toBe(b);
  });

  it('prefixes every key with the tenant', () => {
    const tenant = tenantId('tenant-a');
    expect(tenantKey(tenant, 'device-1').startsWith(tenantKey(tenant, ''))).toBe(true);
  });
});
