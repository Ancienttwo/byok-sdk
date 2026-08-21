/**
 * The one error taxonomy for `@byok-sdk/cloud`.
 *
 * Same idiom as `@byok-sdk/core`'s `errors.ts`: one class, code-based branching,
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
   * The mailbox committed a row `seq` that disagrees with the delivery `seq`
   * its body factory baked into the envelope. Loud rather than silent: those
   * two numbers ARE the daemon's redelivery cursor.
   */
  mailbox_seq_mismatch: 'mailbox_seq_mismatch',
  /** A capability declaration the host supplied that core refused. */
  capability_declaration_invalid: 'capability_declaration_invalid',
  /**
   * The declaration names a capability this composition cannot serve, so the
   * deployment would publish a surface it does not have (ADR-010).
   *
   * Construction-time and fatal. A client learns what a deployment supports by
   * READING the declaration and is entitled to act on it without probing, so a
   * declaration that over-states is not a degraded deployment — it is a
   * deployment whose one honest interface lies.
   */
  capability_over_declared: 'capability_over_declared',
  /** Host-supplied board labels or coordination input exceeded the explicit contract. */
  coordination_input_invalid: 'coordination_input_invalid',
  /**
   * A terminal receipt whose stored body is not a terminal envelope — either
   * undecodable or a non-terminal type. Whatever wrote that row broke the
   * receipt-store contract, so the typed read model fails closed instead of
   * projecting a best-effort shape.
   */
  terminal_receipt_unreadable: 'terminal_receipt_unreadable',
  /** A progress/activity batch exceeded the configured event or byte ceiling. */
  activity_batch_too_large: 'activity_batch_too_large',
  /** Host control-plane task lookup is tenant-closed and found no task. */
  task_not_found: 'task_not_found',
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
