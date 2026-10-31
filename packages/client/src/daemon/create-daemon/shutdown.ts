import { SHUTDOWN_TASK_TEARDOWN_DEADLINE_MS, delay, DEFAULT_SHUTDOWN_OUTBOX_DRAIN_TIMEOUT_MS } from './support';
import type { ShutdownReason } from '../control-protocol';
import type { DaemonScope } from './scope';

/** The shutdown sequence and the control-socket shutdown (#926). */

export async function runShutdownSequence(daemonScope: DaemonScope, reason: string, opts: { drainTimeoutMs?: number } = {}): Promise<void> {
  const {
    daemonState, pendingLateMutationBarriers, config, retentionSweeper, terminalCommits, overrides,
    setLifecycle, operationalHealth,
  } = daemonScope;
  // Plan `device-assertion-broker` (codex F1): the assertion-minting latch is
  // armed at the top of THIS function, synchronously, before the first
  // `await` below. This is the single choke point EVERY teardown path crosses
  // — the control-socket `shutdown` RPC, the public `daemon.stop()`, and
  // `unpair()` all funnel here — so arming it here means `stop()`/`unpair()`
  // close the minting window too, not only the RPC. The RPC handler
  // additionally arms it before its own `setImmediate` defer (see
  // `controlMethods.shutdown`) so a pipelined `shutdown`+`assertion.issue`
  // batch cannot mint in the gap between the RPC returning and this function
  // being scheduled. Latched, never cleared.
  daemonState.shuttingDown = true;
  // Release status waits before service/connection drain. Their mailbox rows
  // remain unacknowledged for a fresh lifecycle to recover authoritatively.
  daemonState.inputPreparationStatusAbort?.abort();
  daemonState.inputPreparationStatusAbort = undefined;
  daemonState.blobLifecycleAbort?.abort();
  daemonState.blobLifecycleAbort = undefined;
  // The member resume and a background KEM rotation write custody entries; they end before this run releases ownership.
  const member = daemonState.deviceMember;
  daemonState.memberAbort?.abort();
  daemonState.memberAbort = undefined;
  daemonState.deviceMember = undefined;
  daemonState.memberResuming = false;
  daemonState.activateSealedTasks = undefined;
  await daemonState.memberResume;
  daemonState.memberResume = undefined;
  await member?.kemRotationSettled();
  const errors: unknown[] = [];
  let mutationBarrierComplete = daemonState.hostedStorageInitializationBarrierComplete;
  if (!daemonState.hostedStorageInitializationBarrierComplete) {
    errors.push(new Error('hosted storage initialization left an unclosed SQLite handle; ownership lease retained'));
  }
  const attempt = async (operation: () => void | Promise<void>, mutationBarrier: boolean): Promise<boolean> => {
    try {
      await operation();
      return true;
    } catch (err) {
      errors.push(err);
      if (mutationBarrier) mutationBarrierComplete = false;
      return false;
    }
  };

  // A prior shutdown attempt may have hit its deadline while task teardown
  // continued in the background. A retry must not release ownership merely
  // because its own fresh runner pass is empty: the late pass is still a
  // possible journal producer until it settles.
  if (pendingLateMutationBarriers.size > 0) {
    const prior = Promise.allSettled([...pendingLateMutationBarriers]);
    let priorSettled = false;
    void prior.then(() => {
      priorSettled = true;
    });
    const graceMs = config.shutdownGraceMs ?? SHUTDOWN_TASK_TEARDOWN_DEADLINE_MS;
    await Promise.race([prior, delay(graceMs)]);
    if (!priorSettled) {
      mutationBarrierComplete = false;
      errors.push(new Error('a prior active task teardown remains unsettled; ownership lease retained'));
    }
  }

  // S3b (L-003): stop the maintenance cadence first — a compaction pass
  // starting while the journal is being drained would hold the single writer
  // against the terminal writes below for no benefit. Only the engine THIS
  // daemon constructed; an injected one belongs to its injector, exactly like
  // an injected journal is not closed here. Idempotent, like every other step
  // in this sequence.
  // Stop beating first, and cancel a discovery that has not resolved yet.
  // Nothing downstream depends on either, and both are pure timers/sockets —
  // no mutation barrier, no errors to collect. Stopping IS this daemon's
  // offline signal: the hosted hint carries a TTL and expiry means absence,
  // so no `offline` publish is (or may be) issued here. Both are idempotent,
  // like every other step in this sequence.
  daemonState.presenceDiscovery?.abort();
  daemonState.presenceDiscovery = undefined;
  // Detached reads cannot publish into a later daemon lifecycle.
  daemonState.presenceDiscoveryPass = undefined;
  daemonState.presencePublisher?.stop();
  daemonState.presencePublisher = undefined;
  // B-P2: abort every counter call this daemon owns. Their outcomes stay
  // observable in the durable record — an aborted call becomes
  // `counter_interrupted`, never a silent cancellation and never an automatic
  // second call on restart (§10.3.5).
  await attempt(() => daemonState.inputPreparationService?.stop(), false);
  const stoppingOwnedJournal = daemonState.ownedJournal;
  const maintenanceStopped = retentionSweeper.stop();
  await attempt(() => daemonState.runner?.stopAcceptingOffers(), true);
  const activeTeardown = daemonState.runner?.shutdownActiveTasks(reason) ?? Promise.resolve();
  const graceMs = config.shutdownGraceMs ?? SHUTDOWN_TASK_TEARDOWN_DEADLINE_MS;
  let activeTeardownSettled = false;
  const observedActiveTeardown = activeTeardown.then(
    () => {
      activeTeardownSettled = true;
    },
    (err: unknown) => {
      activeTeardownSettled = true;
      throw err;
    },
  );
  await attempt(() => Promise.race([observedActiveTeardown, delay(graceMs)]), true);
  if (!activeTeardownSettled) {
    mutationBarrierComplete = false;
    errors.push(new Error('active task teardown did not settle before the shutdown grace deadline'));
    pendingLateMutationBarriers.add(observedActiveTeardown);
    void observedActiveTeardown.finally(() => pendingLateMutationBarriers.delete(observedActiveTeardown)).catch(() => undefined);
  }
  // S3b: in hosted mode, a terminal is journaled before it is handed to the
  // outbox (see `sendEnvelope`), so a `task.fail` that `shutdownActiveTasks`
  // just produced may still be mid-chain right now. Awaiting the chain here
  // — before the drain wait below, which is what decides the connection is
  // idle — is what keeps that fail from being written into an outbox nobody
  // is draining any more. Exactly a no-op before the journal is open.
  // #654: a sealed outbound is handed over before it is sealed. `settled()`
  // resolves once each one reached the outbox or the terminal commit queue
  // (its sender's handler runs first). Wait for it before the drain below
  // decides the connection is idle.
  await attempt(() => daemonState.sealedOutputSettled?.(), false);
  const journalTailSettled = daemonState.journal ? await attempt(() => terminalCommits.stop(), true) : true;
  // This run seals nothing after the barrier: no key or chain view of its
  // member outlives it.
  daemonState.retireSealedMember?.();
  daemonState.retireSealedMember = undefined;
  daemonState.sealedUploadAbort?.abort();
  // stop() cleared the maintenance timer synchronously above. Await the pass
  // that may already have been inside SQLite only here, immediately before
  // closing the owned journal, so task interruption is not held behind a
  // slow checkpoint while the journal-close race remains impossible.
  const maintenanceSettled = await attempt(() => maintenanceStopped, true);
  // Finding F5(b): bounded wait for the outbox (e.g. the task.fail(s)
  // shutdownActiveTasks just enqueued) to actually drain before closing
  // the connection out from under it — see ConnectionManager.stop's own
  // doc comment for why an unbounded wait wasn't safe to make the
  // universal default, and ConnectionManager.outboxLength's own doc
  // comment for the honest-audit read a caller may take afterward.
  const drainTimeoutMs =
    opts.drainTimeoutMs ?? overrides.shutdown?.outboxDrainTimeoutMs ?? DEFAULT_SHUTDOWN_OUTBOX_DRAIN_TIMEOUT_MS;
  const connectionStopped = await attempt(() => daemonState.connection?.stop(drainTimeoutMs), true);
  // Close the owned journal only after every producer has stopped: active
  // task teardown and its terminal tail settled, maintenance settled, and
  // the connection can no longer deliver a new inbound envelope. Closing it
  // earlier would let a failed/slow connection shutdown append into a closed
  // database after this function released the store lease.
  if (activeTeardownSettled && journalTailSettled && maintenanceSettled && connectionStopped) {
    const journalClosed = await attempt(() => stoppingOwnedJournal?.close(), true);
    if (journalClosed) {
      if (daemonState.journal === stoppingOwnedJournal) daemonState.journal = undefined;
      if (daemonState.ownedJournal === stoppingOwnedJournal) daemonState.ownedJournal = undefined;
    }
  } else if (stoppingOwnedJournal) {
    mutationBarrierComplete = false;
  }
  await attempt(() => daemonState.auth.stop(), true);
  // A halt or crash stays visible after teardown, until the next start().
  if (daemonState.lifecycle.phase !== 'halted' && daemonState.lifecycle.phase !== 'crashed') setLifecycle({ phase: 'stopped' });
  // M4 Phase 2: stop the control socket in every shutdown path — this is
  // the single lifecycle choke point every caller (a foreground abort via
  // `bin/commands/start.ts`, `unpair()` below, and the control socket's
  // OWN `shutdown` RPC — see `performControlShutdown`) already funnels
  // through, so nothing else needs its own control-socket teardown logic.
  //
  // Plan `shutdown-lease-order`: that teardown is SPLIT around the lease
  // release, and the order below is the invariant, not an implementation
  // detail. The control socket/token files are this daemon's only external
  // liveness signal — `daemon/control-client.ts`'s `isControlDaemonGone`
  // (which `bin/commands/unpair.ts` polls, and every contender's own
  // "is it gone yet" check mirrors) reads exactly "token file gone AND a
  // connect refused". Removing them while this daemon still holds the
  // store-mutation lease publishes "exited" to a contender whose immediate
  // `acquireDaemonOwner` then hits the still-bound mutex and is refused
  // with `DaemonOwnerActiveError('unknown')` — a measured 11-46ms window
  // (CI job 94465898325's intermittent `ipc-smoke` failure). So:
  // stop serving RPCs, release the lease, and only then remove the files.
  //
  // Stage 1 keeps the mutation-barrier coupling the combined close() had:
  // a stop-serving failure means a control RPC may still be in flight
  // against this store, i.e. a possible residual writer, and the lease
  // must be retained for it.
  await attempt(async () => {
    await daemonState.controlServerHandle?.stopServing();
  }, true);
  daemonState.detachOwnedProcessGroupLedger?.();
  daemonState.detachOwnedProcessGroupLedger = undefined;
  if (mutationBarrierComplete && daemonState.daemonOwnerLease) {
    await attempt(() => operationalHealth.markCleanStop(), false);
    await attempt(async () => {
      await daemonState.daemonOwnerLease?.release();
      daemonState.daemonOwnerLease = undefined;
    }, false);
  }
  // Stage 2, the last observable act of this daemon, and gated on the ONE
  // condition that makes "gone" honest: this process no longer holds the
  // lease. That gate also fixes the `mutationBarrierComplete === false`
  // branch, which used to remove the signal (publishing "exited") while
  // deliberately retaining the lease forever — the combination that turned
  // `unpair`'s intended `UnpairExitUnconfirmedError` into a confusing
  // `DaemonOwnerActiveError` from its post-exit reacquire. Keeping the
  // files in place instead leaves `isControlDaemonGone` false, so unpair's
  // exit poll times out and fails closed with its own typed error, exactly
  // as its "unknown state is unsafe" contract intends. Same gate covers a
  // failed `release()`: the lease is still held, so nothing is published.
  if (daemonState.daemonOwnerLease === undefined) {
    await attempt(async () => {
      await daemonState.controlServerHandle?.close();
      daemonState.controlServerHandle = undefined;
    }, false);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, 'daemon shutdown completed with errors');
  }
  if (!mutationBarrierComplete) {
    // Defensive invariant: every mutation-barrier failure is recorded above.
    // Keep the lease if that invariant is ever violated rather than allowing
    // doctor or a second daemon to overlap a residual writer.
    throw new Error('daemon shutdown mutation barrier is incomplete; ownership lease retained');
  }
  daemonState.daemonStarted = false;
}

/**
 * The control socket's `shutdown` RPC — see this method's own protocol
 * doc comment (`control-protocol.ts`'s `ShutdownParams`) for the wire
 * contract. M5 batch-3 (workstream 2): delegates the actual teardown
 * sequence to `runShutdownSequence` — see that function's own doc comment
 * for the full "stop accepting -> fail active tasks -> drain -> close"
 * sequence every graceful-shutdown path now shares — and wraps it with
 * this RPC's own audit events. Invoked from the RPC handler via
 * `setImmediate` (see `controlMethods` below) so the `{acknowledged:true}`
 * response has already been written to the wire before any of this runs.
 *
 * Gatekeeper-confirmed regression (fixed pre-M5; PRESERVED, not
 * reintroduced, by this refactor): `noteShutdownRequested` fires
 * SYNCHRONOUSLY, before `shutdownActiveTasks` even calls
 * `session.interrupt()` — `observer.emit()` calls its listeners
 * synchronously, so `bin/commands/start.ts`'s subscriber used to be woken
 * IMMEDIATELY, race ahead, and call `daemon.stop()` (which sets
 * `ConnectionManager.stopped = true` synchronously) before the active
 * task's `task.fail` was ever sent — silently stranding it in a
 * post-`stopped` outbox that `drainOutbox` refuses to flush. Fixed by
 * emitting a SEPARATE, later `shutdown-complete` event only once
 * `runShutdownSequence` below has fully resolved — `start.ts` now waits
 * for that one instead, so it can never race ahead of this function's own
 * internal ordering. `shutdown-requested` is kept as an earlier,
 * informational-only audit marker; nothing may gate teardown decisions on
 * it. The ordering itself (stopAcceptingOffers -> shutdownActiveTasks ->
 * THEN connection teardown) now lives inside `runShutdownSequence` rather
 * than duplicated in this function's own body, but the observable
 * guarantee `start.ts` depends on — `shutdown-complete` fires only after
 * every active task's `task.fail` has actually been enqueued and the
 * connection has begun closing — is unchanged.
 */
export async function performControlShutdown(daemonScope: DaemonScope, reason: ShutdownReason | undefined): Promise<void> {
  const { daemonState, observer, requestShutdown } = daemonScope;
  const effectiveReason = reason ?? 'operator';
  // Plan `device-assertion-broker` (codex F1): belt-and-suspenders re-arm of
  // the minting latch. The `shutdown` RPC handler already set it
  // synchronously before deferring this function, and `runShutdownSequence`
  // (called below, via `requestShutdown`) sets it again — but re-asserting it
  // here keeps this function correct on its own terms regardless of how it is
  // reached, and setting an already-`true` boolean is free.
  daemonState.shuttingDown = true;
  observer.noteShutdownRequested(effectiveReason);
  // Hardening finding (P2 re-gate): `noteShutdownComplete` now fires in a
  // `finally` — `start.ts`'s own wait for THIS event (see the doc comment
  // above) is what makes `runStartCommand` return at all. Before this fix,
  // a throw anywhere in the body below (every step `runShutdownSequence`
  // takes is best-effort in its OWN implementation today, but nothing here
  // guaranteed one of them could never throw in the future) would
  // propagate out of this function without ever emitting
  // `shutdown-complete`, leaving `start.ts` waiting forever — exactly the
  // class of hang this event was introduced to prevent in the first
  // place. `finally` runs on both the success path and any throw, and does
  // not swallow the throw itself (it still propagates to this function's
  // own caller — the `shutdown` control method's `.catch()` in
  // `controlMethods` below — afterward).
  try {
    await requestShutdown(`control socket shutdown (${effectiveReason})`);
  } finally {
    // Finding F5(b): read AFTER runShutdownSequence() returns — 0 means
    // the drain genuinely finished in time; a positive count is an honest
    // record that this many envelopes (almost certainly including a
    // task.fail shutdownActiveTasks just sent) never actually left the
    // outbox, rather than the audit log silently implying full delivery.
    observer.noteShutdownComplete(effectiveReason, daemonState.connection?.outboxLength() ?? 0);
  }
}
