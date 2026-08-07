/**
 * `@byok/core` — platform contracts.
 *
 * What this package exports is deliberately narrow: contracts, schemas, errors,
 * and one in-memory reference implementation. No HTTP, no crypto, no SQL, no
 * `@byok/protocol` (that edge would make a future `keys → core` dependency drag
 * the wire protocol along with it, §12.1), and no `node:` import (a Workers
 * composition has to be able to load this).
 *
 * `src/__tests__/constraints.test.ts` asserts every one of those properties
 * against the source, including this export list.
 */

// Identity (§12.6.2)
export {
  tenantId,
  isTenantId,
  tenantKey,
  TENANT_ID_MAX_LENGTH,
  TENANT_KEY_SEPARATOR,
} from './tenant';
export type { TenantId } from './tenant';

export {
  PRINCIPAL_KINDS,
  isDevicePrincipal,
  isControlPlanePrincipal,
  principalTenant,
} from './principals';
export type {
  ControlPlanePrincipal,
  DevicePrincipal,
  Principal,
  PrincipalKind,
} from './principals';

// Errors (single taxonomy)
export { ByokCoreError, CoreConflictError, CORE_ERROR_CODES, isCoreError, isCoreConflictError } from './errors';
export type { CoreErrorCode } from './errors';
