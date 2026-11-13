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

/**
 * Runs one submission under the section lock. The lock is held until the list reload that follows a receipt has
 * landed, so whenever the section is interactive the list on screen is current; it is released on every settle path.
 */
export async function runLocked(
  setBusy: (busy: boolean) => void, run: () => Promise<SubmitOutcome>, onOutcome: (outcome: SubmitOutcome) => void, reload: () => Promise<void>,
): Promise<void> {
  setBusy(true);
  try {
    const outcome = await run();
    onOutcome(outcome);
    if ('receipt' in outcome) await reload();
  } finally {
    setBusy(false);
  }
}

export function refusalOf(error: unknown): Refusal {
  if (error instanceof BridgeCallError) return { code: error.code, message: error.message };
  return { message: error instanceof Error ? error.message : String(error) };
}

/**
 * A listed status as model-route's stored profile: the device's public state, which never holds the key. A key behind
 * an unfinished credential change may not be used, so such a profile offers only a new key, never `keep`.
 */
export function storedProfile(status: ProviderStatus): ModelRouteStoredProfile {
  const { profile_ref, display_name, provider_kind, adapter, auth_mode, base_url, model, capabilities, pi_model } = status;
  return {
    profile: { profile_ref, display_name, provider_kind, adapter, auth_mode, base_url, model, capabilities: [...capabilities], ...(pi_model === undefined ? {} : { pi_model }) },
    secret_configured: status.secret_configured && !status.configuration_pending,
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

/**
 * Submits the draft, clearing its typed key through `onDraft` before calling the bridge.
 * `keep` and `none` carry no key and stay.
 */
export async function submitModelRoute(
  draft: ModelRouteDraft, context: ModelRouteContext, stored: ProviderStatus | null, submit: KeysSubmit, onDraft: (draft: ModelRouteDraft) => void,
): Promise<SubmitOutcome> {
  const submission = modelRouteSubmission(draft, context);
  onDraft(typeof draft.secret === 'object' ? applyModelRouteChange(draft, { field: 'secret', value: 'none' }, context) : draft);
  if (!submission.ok) return { refusal: { message: 'The form has errors; fix the marked fields.' } };
  return submitOnce(custodyRequest(submission, stored), submit);
}

/** Replaces a stored profile's key and nothing else; the caller clears its key input whatever the outcome. */
export function submitReplaceSecret(profileRef: string, secret: string, submit: KeysSubmit): Promise<SubmitOutcome> {
  return submitOnce({ op: 'replace_secret', profileRef, secret }, submit);
}
