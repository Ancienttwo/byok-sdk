import type { ProviderStatus } from '@byok-sdk/keys';
import {
  applyModelRouteChange, modelRouteSubmission,
  type ModelRouteContext, type ModelRouteDraft, type ModelRouteStoredProfile, type ModelRouteSubmission,
} from '@byok-sdk/keys/model-route';
import type { CustodyChange } from '../../custody/protocol.ts';
import { BridgeCallError } from '../bridge.ts';

/** `keys.submit` as the renderer calls it: main hands the change to a custody child and returns its secret-free status. */
export type KeysSubmit = (change: CustodyChange) => Promise<ProviderStatus>;

/** A refusal as the bridge reported it; `code` is absent only when the failure did not come back as a bridge refusal. */
export interface Refusal { readonly code?: string; readonly message: string }

/** What one submission shows: the custody receipt, or the refusal. */
export type SubmitOutcome = { readonly receipt: ProviderStatus } | { readonly refusal: Refusal };

export function refusalOf(error: unknown): Refusal {
  if (error instanceof BridgeCallError) return { code: error.code, message: error.message };
  return { message: error instanceof Error ? error.message : String(error) };
}

/** A listed status as model-route's stored profile: the device's public state, which never holds the key. */
export function storedProfile(status: ProviderStatus): ModelRouteStoredProfile {
  const { profile_ref, display_name, provider_kind, adapter, auth_mode, base_url, model, capabilities, pi_model } = status;
  return {
    profile: { profile_ref, display_name, provider_kind, adapter, auth_mode, base_url, model, capabilities: [...capabilities], ...(pi_model === undefined ? {} : { pi_model }) },
    secret_configured: status.secret_configured,
  };
}

/**
 * A `configure` change for a valid draft. Only a `replace` key travels; `keep` and `none` send none. The registry
 * makes a configured profile the default unless told otherwise, so an edit of a stored profile carries its `enabled`.
 */
export function custodyRequest(submission: Extract<ModelRouteSubmission, { ok: true }>, stored: ProviderStatus | null): CustodyChange {
  const { kind: _kind, ...profile } = submission.profile;
  const configuration = stored?.profile_ref === profile.profile_ref ? { ...profile, enabled: stored.enabled } : profile;
  const { secret } = submission;
  return { op: 'configure', configuration, ...(typeof secret === 'object' ? { secret: secret.replace } : {}) };
}

/**
 * Sends one change, once. A refusal is returned for the user to read, never retried: when custody stored the key
 * but the Host then refused the new catalog, a resubmission would write the key again.
 */
async function submitOnce(change: CustodyChange, submit: KeysSubmit): Promise<SubmitOutcome> {
  try {
    return { receipt: await submit(change) };
  } catch (error) {
    return { refusal: refusalOf(error) };
  }
}

/** Submits the draft. The key leaves the returned draft whatever the outcome, so it never outlives the submission in the renderer. */
export async function submitModelRoute(draft: ModelRouteDraft, context: ModelRouteContext, stored: ProviderStatus | null, submit: KeysSubmit): Promise<{ draft: ModelRouteDraft; outcome: SubmitOutcome }> {
  const cleared = applyModelRouteChange(draft, { field: 'secret', value: 'none' }, context);
  const submission = modelRouteSubmission(draft, context);
  if (!submission.ok) return { draft: cleared, outcome: { refusal: { message: 'The form has errors; fix the marked fields.' } } };
  return { draft: cleared, outcome: await submitOnce(custodyRequest(submission, stored), submit) };
}

/** Replaces a stored profile's key and nothing else; the caller clears its key input whatever the outcome. */
export function submitReplaceSecret(profileRef: string, secret: string, submit: KeysSubmit): Promise<SubmitOutcome> {
  return submitOnce({ op: 'replace_secret', profileRef, secret }, submit);
}
