// `TaskRunner` members for offer admission before any runtime work, and for
// sealed offers (see ./support.ts for how a member module runs).
import { requiredReceiverCapabilities, type Envelope, type SealedDeclineCode } from '@byok-sdk/protocol';
import { AgentHomeBusyError, AgentHomeResolutionError, type AgentRef } from '../../agent-home';
import { isReaderRunName, type AgentHomeAccessMode } from '../../agent-home-readers';
import type { OfferPhaseContext } from './support';
import { settledOrWithdrawn, outboundErrorMessage } from './support';
import type { TaskRunner } from '../task-runner';
import type { AcceptedOfferPayload } from './support';
import type { OfferAdmissionTiming } from './offer-admission-timing';

export function admitOffer(this: TaskRunner, phase: OfferPhaseContext): true | undefined {
  const { taskId, decline } = phase;
  // Finding F4, checkpoint 1 ("before claim where possible -> decline
  // path"): a task.cancel already arrived for this exact taskId before
  // this offer was even looked at. Decline outright — never claim, never
  // spawn a runtime session for a task that's already dead. Checked first
  // (ahead of every other pre-claim check below) so a pre-cancelled offer
  // costs nothing beyond this map lookup.
  if (this['pendingCancelled'].has(taskId)) {
    const reason = this['pendingCancelled'].get(taskId);
    this['pendingCancelled'].delete(taskId);
    decline(reason ? `cancelled before claim: ${reason}` : 'cancelled before claim', false);
    return undefined;
  }
  return true;
}

export async function reserveOfferHome(
  this: TaskRunner,
  phase: OfferPhaseContext,
  agentRef: AgentRef,
  readerAttempt: boolean,
  sessionRef: string | undefined,
  homeAccess: AgentHomeAccessMode,
): Promise<true | undefined> {
  const { taskId, decline, admissionWithdrawn, admissionSignal, reserveHome } = phase;
  // WP0 (canonical Agent home single writer): execution is serialized per
  // canonical Agent home. Placed exactly here — after the receive, dedup,
  // and pre-cancel precedence above, before adapter
  // preparation, the workspace, the claim, or any process side effect —
  // so a duplicate or pre-cancelled offer returns above without ever
  // consuming a slot, and a busy home costs the offer nothing beyond this
  // count.
  //
  // Counted per HOME, not per lane: two different runtimes on two
  // different lanes still share `MEMORY.md`, `notes/` and `.git` in that
  // one directory, and only a per-home count stops them co-writing it.
  // The decline reason carries counts only — never a path, never prompt
  // text — because `task.decline` leaves this device.
  //
  // Canonical-home reservations bridge this check and lease acquisition.
  // Different homes may start concurrently; check-and-reserve has no await.
  //
  // #476: an Attempt whose semantic terminal is already published still
  // holds its lease until `finishOnce` releases it after `Session.close()`,
  // the terminal commit and the memory snapshot. A Host that offers the
  // same home right after observing that terminal would otherwise race the
  // release. So when the count is at the limit and enough of it belongs to
  // this runner's Attempts that are already finishing (finalization started
  // and an in-flight finalization attempt), admission waits ONCE for those
  // attempts to settle (or for the offer to be withdrawn), then recounts
  // from the lease registry and reserves or declines exactly as without the
  // wait. A finished Attempt with no in-flight finalization (failed
  // disposal, retained ownership) is a live holder and is never waited on.
  // Once offers are stopping, there is no wait at all.
  // The lease registry stays the only admission authority; the wait only
  // decides when to read it.
  //
  // The count key is derived with `canonicalHomePath()`, NOT `resolve()`:
  // this gate runs before the host's own admission veto, so it must not
  // create `agents/<agentId>` or bind an Agent identity for an offer that
  // is about to be declined. `resolve()` still runs later, on the
  // admission path, for an offer that actually executes.
  //
  // Writers and `memory-reader` Attempts are counted apart: one writer,
  // and up to `maxConcurrentReaderAttemptsPerAgentHome` readers, each in
  // its own run directory. A fresh reader names that directory after its
  // taskId, so a taskId that is not one plain path segment is refused here,
  // before any side effect.
  if (readerAttempt && sessionRef === undefined && !isReaderRunName(taskId)) {
    decline('a memory-reader Attempt needs a taskId that is one plain path segment ([A-Za-z0-9._-], at most 128 characters)', false);
    return undefined;
  }
  const limit = readerAttempt ? this['maxConcurrentReaderAttemptsPerAgentHome'] : 1;
  let canonicalHome: string;
  try {
    canonicalHome = await this['deps'].agentHome!.layout.canonicalHomePath(agentRef);
  } catch (error) {
    decline(
      `Agent home admission failed: ${outboundErrorMessage(error)}`,
      !(error instanceof AgentHomeResolutionError),
      error instanceof AgentHomeBusyError
        ? readerAttempt ? 'agent_home_reader_busy' : 'agent_home_writer_busy'
        : undefined,
    );
    return undefined;
  }
  if (admissionWithdrawn()) return undefined;
  const reservationKey = `${homeAccess}\0${canonicalHome}`;
  const countHome = (): number => this['deps'].agentHome!.executionLeaseManager.activeAttemptCount(canonicalHome, homeAccess)
    + (this['homeReservations'].get(reservationKey) ?? 0);
  let active = countHome();
  // A daemon that is stopping never parks an offer: `stopAcceptingOffers`
  // aborts only the admission signals that existed when it ran, so an offer
  // that arrived after it would otherwise wait on a finishing Attempt.
  if (active >= limit && !this['stoppingOffers']) {
    const finishing = this['homeFinalizations'](canonicalHome, homeAccess);
    if (finishing.length > 0 && active - finishing.length < limit) {
      await phase.admission.time('agentHomeWaitMs', () => settledOrWithdrawn(finishing, admissionSignal));
      if (admissionWithdrawn()) return undefined;
      active = countHome();
    }
  }
  if (active >= limit) {
    decline(`agent home busy: ${active} active ${readerAttempt ? 'reader ' : ''}attempt(s)`, true,
      readerAttempt ? 'agent_home_reader_busy' : 'agent_home_writer_busy');
    return undefined;
  }
  // Check and reserve are synchronous at the canonical-home authority.
  reserveHome(reservationKey);
  return true;
}

export function admitOfferLimits(this: TaskRunner, phase: OfferPhaseContext, payload: AcceptedOfferPayload) {
  const { taskId, decline } = phase;
  // S3b (L-002): the pre-claim admission veto stays after the strict
  // receive/dedup/cancel precedence above and before every runtime or
  // workspace side effect.
  const guarded = this['deps'].admissionGuard?.({ taskId, payload });
  if (guarded !== undefined && !guarded.admit) {
    decline(guarded.reason, guarded.retryable);
    return undefined;
  }

  // M4 Phase 2: the control socket's `shutdown` RPC flips this before
  // tearing down active tasks — any later offer is declined outright.
  if (this['stoppingOffers']) {
    decline('daemon is shutting down', true);
    return undefined;
  }

  // M5 batch-3 (workstream 1): `limits.maxTokens` has no hard-enforcement
  // path on ANY bundled runtime adapter today — nothing actually counts
  // or caps tokens against it. Silently accepting the offer would let a
  // caller believe a token ceiling is in effect when nothing checks it;
  // declining fail-closed, pre-claim, is honest about that gap and lets
  // the dispatcher route the task elsewhere instead of running
  // unbounded. `retryable: true` — a different device's adapter set (or
  // a future SDK version) might genuinely enforce this, so re-routing
  // can help even though nothing here can. `limits.maxDurationMs` is
  // deliberately left OUT of this admission gate: unlike maxTokens, it
  // IS hard-enforced — daemon-authoritative, at the TaskRunner layer
  // itself (a wall-clock timer armed once this task is registered as
  // active — see `armMaxDurationTimer` — not delegated to any adapter),
  // so there is no gap here to decline fail-closed for.
  if (payload.limits?.maxTokens !== undefined) {
    decline(
      `offer requests limits.maxTokens (${payload.limits.maxTokens}), which no bundled runtime adapter enforces — declining fail-closed rather than silently ignoring it`,
      true,
    );
    return undefined;
  }

  if (
    payload.dispatchSelection !== undefined &&
    payload.runtime !== undefined &&
    payload.runtime !== payload.dispatchSelection.runtimeId
  ) {
    decline(
      `offer runtime ${payload.runtime} does not match dispatchSelection.runtimeId ${payload.dispatchSelection.runtimeId}`,
      false,
    );
    return undefined;
  }

  if (payload.harnessId !== undefined && (payload.runtime !== undefined || payload.dispatchSelection !== undefined)) {
    decline('harnessId cannot be combined with a built-in runtime selection', false);
    return undefined;
  }
  if (payload.harnessId !== undefined && !(this['deps'].getServerCapabilities?.() ?? []).includes('custom-harness')) {
    decline('server does not support custom-harness identity', false);
    return undefined;
  }
  const requiredToolsets = payload.requiredToolsets;
  const resolvedMcp = requiredToolsets ? this['resolveMcpServers'](requiredToolsets) : undefined;
  if (resolvedMcp && !resolvedMcp.ok) {
    decline(resolvedMcp.reason, true);
    return undefined;
  }
  return { requiredToolsets, resolvedMcp };
}

/**
 * The receiver half of the gates (#925 O4): `requiredReceiverCapabilities` of
 * the wire offer must be a subset of the flags this daemon advertises, or the
 * offer is declined non-retryably before it is opened, claimed or run. The
 * sender checks the same rows, so a sender that misses one cannot run an offer
 * here. A redelivered offer of a task this daemon already holds, ran or
 * declined is dropped without a second decline. A task that seals its output
 * takes the closed sealed decline, because the Host accepts no free-text
 * reason for it.
 */
export function declineOfferMissingCapabilities(this: TaskRunner, envelope: Extract<Envelope, { type: 'task.offer' }>, admission: OfferAdmissionTiming): boolean {
  const taskId = envelope.task_id;
  const advertised = this['deps'].advertisedCapabilities();
  const missing = requiredReceiverCapabilities('task.offer', envelope.payload).filter((flag) => !advertised.includes(flag));
  if (missing.length === 0) return false;
  if (this['tasks'].has(taskId) || this['startupOwnership'].has(taskId) || this['inFlightOffers'].has(taskId) || this['finishedTaskIds'].has(taskId) || this['strictDeclinedTaskIds'].has(taskId) || this['sealedOpening'].has(taskId)) return true;
  const { agentRef, sealing } = envelope.payload;
  console.error(`[byok/client] task.offer for task ${taskId} declined: this daemon does not advertise ${missing.join(', ')}`);
  if (sealing?.categories.includes('task-output') === true) {
    this['declineSealedOffer'](taskId, admission, agentRef, 'sealed_key_unavailable');
    return true;
  }
  this['addStrictDeclinedTaskId'](taskId);
  this['decline'](taskId, admission, `offer_capability_missing: this daemon does not advertise ${missing.join(', ')}`, false, agentRef);
  return true;
}

export async function handleSealedOffer(this: TaskRunner, envelope: Envelope, admission: OfferAdmissionTiming): Promise<void> {
  const taskId = envelope.task_id!;
  if (this['tasks'].has(taskId) || this['startupOwnership'].has(taskId) || this['inFlightOffers'].has(taskId) || this['finishedTaskIds'].has(taskId) || this['strictDeclinedTaskIds'].has(taskId) || this['sealedOpening'].has(taskId)) return;
  const agentRef = (envelope.payload as { agentRef?: AgentRef }).agentRef;
  const sealedTasks = this['deps'].sealedTasks;
  if (sealedTasks === undefined || !this['sealedCodesAllowed']()) {
    this['declineSealedOffer'](taskId, admission, agentRef, 'sealed_key_unavailable');
    return;
  }
  this['sealedOpening'].add(taskId);
  try {
    const opened = await sealedTasks.openOffer(envelope);
    if (!opened.ok) {
      this['declineSealedOffer'](taskId, admission, agentRef, opened.code);
      return;
    }
    await this['handleOffer'](taskId, opened.offer.payload as AcceptedOfferPayload, admission);
  } finally {
    this['sealedOpening'].delete(taskId);
  }
}

export function declineSealedOffer(this: TaskRunner, taskId: string, admission: OfferAdmissionTiming, agentRef: AgentRef | undefined, code: SealedDeclineCode): void {
  if (this['strictDeclinedTaskIds'].has(taskId)) return;
  this['addStrictDeclinedTaskId'](taskId);
  if (this['sealedCodesAllowed']()) {
    this['decline'](taskId, admission, code, false, agentRef, code);
  } else {
    const why = this['deps'].sealedTasks === undefined ? 'this daemon does not open sealed task input' : 'the server does not accept sealed task output';
    this['decline'](taskId, admission, `sealed_payload_unsupported: ${why}`, false, agentRef);
  }
}
