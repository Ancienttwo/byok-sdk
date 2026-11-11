/**
 * The custody child's one-shot protocol: main writes one request to its stdin
 * and reads one receipt line from its stdout. Main imports this file, so it
 * holds types only and no SDK runtime code.
 */
import type { ProviderConfiguration, ProviderStatus } from '@byok-sdk/keys';

/** The argv command under which the Host executable re-enters as the custody child. */
export const CUSTODY_COMMAND = 'byok-desktop-custody';

/** A change carries the secret once, to the custody child only. */
export type CustodyChange =
  | { readonly op: 'configure'; readonly configuration: ProviderConfiguration; readonly secret?: string }
  | { readonly op: 'replace_secret'; readonly profileRef: string; readonly secret: string };

/** `list` carries nothing but its op: no secret goes in, and the statuses that come out hold none. */
export type CustodyRequest = CustodyChange | { readonly op: 'list' };

/** A change's committed profile status, or a list's statuses: secret-free, as the registry reports them. */
export type CustodyResult = { readonly status: ProviderStatus } | { readonly statuses: readonly ProviderStatus[] };

/** What crosses back to main: the result, or the refusal. */
export type CustodyReceipt =
  | ({ readonly ok: true } & CustodyResult)
  | { readonly ok: false; readonly code: string; readonly message: string };

/** A receipt that committed or answered. */
export type CustodyAnswer = Extract<CustodyReceipt, { ok: true }>;

export class CustodyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CustodyError';
    this.code = code;
  }
}
