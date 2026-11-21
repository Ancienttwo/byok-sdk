import type { RuntimeFailureClass } from '@byok-sdk/protocol';

/** OAR also distinguishes a model's refusal from a structured SDK task failure. */
export type OarFailureClass = RuntimeFailureClass | 'model_refused';

/** What an HTTP status means at the providers when nothing richer says. */
export declare function failureFromStatus(status: number): OarFailureClass;
