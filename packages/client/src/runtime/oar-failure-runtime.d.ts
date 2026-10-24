// OAR 0.37.0 failure tables. scripts/api-surface/oar-bridge-types.ts checks these types against the vendor source.
import type { RuntimeFailureClass } from '@byok-sdk/protocol';
/** A failed codex turn, classified from its `turn.error.codexErrorInfo`; the SDK reads only `failure`. */
export declare function codexFailure(reason: string, turnError: unknown): { readonly failure: RuntimeFailureClass };
/** What an HTTP status means at the providers when nothing richer says. */
export declare function failureFromStatus(status: number): RuntimeFailureClass;
