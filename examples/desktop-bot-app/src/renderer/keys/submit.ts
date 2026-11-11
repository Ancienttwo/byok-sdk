import type { ProviderStatus } from '@byok-sdk/keys';
import { applyModelRouteChange, modelRouteSubmission, type ModelRouteContext, type ModelRouteDraft, type ModelRouteSubmission } from '@byok-sdk/keys/model-route';
import type { CustodyChange } from '../../custody/protocol.ts';

/** `keys.submit` as the renderer calls it: main hands the request to a custody child and returns its secret-free status. */
export type KeysSubmit = (request: CustodyChange) => Promise<ProviderStatus>;

/** What one submission shows: the custody receipt, or the refusal exactly as the bridge reported it. */
export type SubmitOutcome = { readonly receipt: ProviderStatus } | { readonly error: string };

/** A `configure` request for a valid draft. Only a `replace` key travels; `keep` and `none` send none. */
export function custodyRequest(submission: Extract<ModelRouteSubmission, { ok: true }>): CustodyChange {
  const { kind: _kind, ...configuration } = submission.profile;
  const { secret } = submission;
  return { op: 'configure', configuration, ...(typeof secret === 'object' ? { secret: secret.replace } : {}) };
}

/**
 * Submits the draft once. The key leaves the returned draft whatever the outcome, so it never outlives the
 * submission in the renderer. A refusal is returned for the user to read, never retried: when custody stored the
 * key but the Host then refused the new catalog, a resubmission would write the key again.
 */
export async function submitModelRoute(draft: ModelRouteDraft, context: ModelRouteContext, submit: KeysSubmit): Promise<{ draft: ModelRouteDraft; outcome: SubmitOutcome }> {
  const cleared = applyModelRouteChange(draft, { field: 'secret', value: 'none' }, context);
  const submission = modelRouteSubmission(draft, context);
  if (!submission.ok) return { draft: cleared, outcome: { error: 'The form has errors; fix the marked fields.' } };
  try {
    return { draft: cleared, outcome: { receipt: await submit(custodyRequest(submission)) } };
  } catch (error) {
    return { draft: cleared, outcome: { error: (error as Error).message } };
  }
}
