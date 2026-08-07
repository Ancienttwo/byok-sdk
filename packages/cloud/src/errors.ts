/**
 * The one error taxonomy for `@byok/cloud`.
 *
 * Same idiom as `@byok/core`'s `errors.ts`: one class, code-based branching,
 * so a composition maps failures onto HTTP with a code table instead of an
 * `instanceof` chain. Cloud does not re-export core's codes — a cloud error is
 * about the hosted surface (a store contract the composition broke, a
 * declaration the host mis-configured), and core errors travel up unchanged.
 */

export const CLOUD_ERROR_CODES = {
  /** A pairing code that is unknown, expired, or already redeemed (§6.1). */
  pairing_code_invalid: 'pairing_code_invalid',
  /** The composition handed a device row whose tenant is not a mintable `TenantId`. */
  device_tenant_invalid: 'device_tenant_invalid',
  /**
   * The mailbox assigned a row `seq` that disagrees with the delivery `seq`
   * baked into the enqueued envelope. Loud rather than silent: those two
   * numbers ARE the daemon's redelivery cursor, and a composition whose
   * mailbox numbers rows differently from `DeviceSequenceStore` would
   * mis-deliver every subsequent poll.
   */
  mailbox_seq_mismatch: 'mailbox_seq_mismatch',
  /** A capability declaration the host supplied that core refused. */
  capability_declaration_invalid: 'capability_declaration_invalid',
} as const;

export type CloudErrorCode = (typeof CLOUD_ERROR_CODES)[keyof typeof CLOUD_ERROR_CODES];

export class ByokCloudError extends Error {
  public readonly code: CloudErrorCode;

  constructor(code: CloudErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ByokCloudError';
    this.code = code;
  }
}

export function isCloudError(value: unknown, code?: CloudErrorCode): value is ByokCloudError {
  if (!(value instanceof ByokCloudError)) return false;
  return code === undefined || value.code === code;
}
