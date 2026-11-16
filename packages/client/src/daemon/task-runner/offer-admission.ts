// `TaskRunner` members for offer admission before any runtime work, and for
// sealed offers (see ./support.ts for how a member module runs).
import { offerSelectionViolation, requiredReceiverCapabilities, type Envelope, type SealedDeclineCode, type TaskDeclineCode } from '@byok-sdk/protocol';
import { AgentHomeBusyError, AgentHomeResolutionError, type AgentRef } from '../../agent-home.js';
import { isReaderRunName, type AgentHomeAccessMode } from '../../agent-home-readers.js';
import type { OfferPhaseContext } from './support.js';
import { outboundErrorMessage } from '../outbound-error.js';
import { hostDeclineSender, settledOrWithdrawn } from './support.js';
import type { TaskRunner } from '../task-runner.js';
import type { AcceptedOfferPayload } from './support.js';
import type { OfferAdmissionTiming } from './offer-admission-timing.js';
import { hostFor } from './host.js';
import { createOfferFacts, offerSettled } from './state.js';

/**
 * Suppress redelivered offers for owned tasks and recently finished tasks.
 * The finished/strict-declined rule belongs to the reducer (`offerSettled`,
 * applied by O1); this guard adds the runner's ownership registries, which
 * the reducer cannot see, and runs before `beginOffer` archives the task's
 * previous state.
 * The reducer's finished list retains the most recent MAX_TRACKED_TASK_IDS
 * ids, evicting the oldest first. This is a bounded redelivery horizon: a
 * connection stalled across more finished tasks can redeliver an evicted id,
 * which runs again from scratch and can repeat claim/start/complete.
 * Finished entries have selected a terminal outcome; eviction cannot discard
 * an in-flight cancellation as the pending-cancel collection could.
 */
export function offerAlreadyHandled(this: TaskRunner, taskId: string): boolean {
  return this['tasks'].has(taskId) || this['startupOwnership'].has(taskId)
    || this['inFlightOffers'].has(taskId) || offerSettled(hostFor(this).runnerSnapshot(), taskId);
}

export function offerHasOwner(this: TaskRunner, taskId: string): boolean {
  return offerAlreadyHandled.call(this, taskId) || this['sealedOpening'].has(taskId)
    || hostFor(this).current(taskId) !== undefined;
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
    decline({ reason: 'a memory-reader Attempt needs a taskId that is one plain path segment ([A-Za-z0-9._-], at most 128 characters)', retryable: false });
    return undefined;
  }
  const limit = readerAttempt ? this['maxConcurrentReaderAttemptsPerAgentHome'] : 1;
  let canonicalHome: string;
  try {
    canonicalHome = await this['deps'].agentHome!.layout.canonicalHomePath(agentRef);
  } catch (error) {
    decline({
      reason: `Agent home admission failed: ${outboundErrorMessage(error)}`,
      retryable: !(error instanceof AgentHomeResolutionError),
      ...(error instanceof AgentHomeBusyError
        ? { code: readerAttempt ? 'agent_home_reader_busy' : 'agent_home_writer_busy' }
        : {}),
    });
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
    decline({
      reason: `agent home busy: ${active} active ${readerAttempt ? 'reader ' : ''}attempt(s)`,
      retryable: true,
      code: readerAttempt ? 'agent_home_reader_busy' : 'agent_home_writer_busy',
    });
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
    decline({ reason: guarded.reason, retryable: guarded.retryable });
    return undefined;
  }

  // M4 Phase 2: the control socket's `shutdown` RPC flips this before
  // tearing down active tasks — any later offer is declined outright.
  if (this['stoppingOffers']) {
    decline({ reason: 'daemon is shutting down', retryable: true });
    return undefined;
  }

  // #1121: one device runs at most `maxConcurrentTasks` tasks, whatever their
  // Agent homes. An offer admitted here counts until it is active, then as an
  // active task, so a burst of offers cannot overshoot the cap while earlier
  // ones are still starting. Check and reserve are synchronous.
  const deviceTasks = new Set([...this['tasks'].keys(), ...this['deviceTaskReservations']]).size;
  if (deviceTasks >= this['maxConcurrentTasks']) {
    decline({ reason: `device busy: ${deviceTasks} of ${this['maxConcurrentTasks']} concurrent task(s) in use`, retryable: true });
    return undefined;
  }
  this['deviceTaskReservations'].add(taskId);

  const requiredToolsets = payload.requiredToolsets;
  const resolvedMcp = requiredToolsets ? this['resolveMcpServers'](requiredToolsets) : undefined;
  if (resolvedMcp && !resolvedMcp.ok) {
    decline({ reason: resolvedMcp.reason, retryable: true });
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
  // The offer selection rules run before any native-sessions support check
  // (docs/protocol.md §3.2 "Order on the device"): an offer they reject keeps
  // its rule's code, which `handleOffer` sends, even on a device without
  // native sessions. Every other missing flag still declines here first.
  const selectionViolated = offerSelectionViolation(envelope.payload) !== undefined;
  const missing = requiredReceiverCapabilities('task.offer', envelope.payload)
    .filter((flag) => !advertised.includes(flag) && !(selectionViolated && flag === 'native-sessions'));
  if (missing.length === 0) return false;
  if (offerAlreadyHandled.call(this, taskId) || this['sealedOpening'].has(taskId)) return true;
  const { agentRef, sealing } = envelope.payload;
  console.error(`[byok/client] task.offer for task ${taskId} declined: this daemon does not advertise ${missing.join(', ')}`);
  const nativeSessionsMissing = missing.includes('native-sessions');
  if (sealing?.categories.includes('task-output') === true) {
    this['declineSealedOffer'](taskId, admission, agentRef, nativeSessionsMissing ? 'native_sessions_unsupported' : 'sealed_key_unavailable');
    return true;
  }
  declineStrict.call(this, taskId, admission, agentRef, nativeSessionsMissing
    ? { reason: 'native_sessions_unsupported', code: 'native_sessions_unsupported' }
    : { reason: `this daemon does not advertise ${missing.join(', ')}`, code: 'offer_capability_missing' }, false);
  return true;
}

export async function handleSealedOffer(this: TaskRunner, envelope: Envelope, admission: OfferAdmissionTiming): Promise<void> {
  const taskId = envelope.task_id!;
  if (offerAlreadyHandled.call(this, taskId) || this['sealedOpening'].has(taskId)) return;
  const agentRef = (envelope.payload as { agentRef?: AgentRef }).agentRef;
  const sealedTasks = this['deps'].sealedTasks;
  if (sealedTasks === undefined) {
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

function declineStrict(this: TaskRunner, taskId: string, admission: OfferAdmissionTiming, agentRef: AgentRef | undefined, { reason, code }: { readonly reason: string; readonly code: TaskDeclineCode }, sealed: boolean): void {
  const host = hostFor(this);
  host.beginOffer(taskId, { stage: 'receive', sendDecline: hostDeclineSender.call(this, taskId, admission) });
  host.setAgentRef(taskId, agentRef);
  try {
    host.dispatchSync({ type: 'offer.received', taskId, atMs: Date.now(), offer: createOfferFacts({ digest: taskId, strict: true, sealed }) });
    host.dispatchSync({ type: 'admission.declined', taskId, atMs: Date.now(), stage: 'receive', reason, retryable: false, strict: true, code });
  } finally {
    host.endOffer(taskId);
  }
}

export function declineSealedOffer(this: TaskRunner, taskId: string, admission: OfferAdmissionTiming, agentRef: AgentRef | undefined, code: SealedDeclineCode): void {
  declineStrict.call(this, taskId, admission, agentRef, { reason: code, code }, true);
}
