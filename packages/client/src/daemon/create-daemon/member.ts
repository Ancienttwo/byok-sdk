import { type DeviceRecord, enrollmentIdentityOf } from '../store';
import { E2eeMemberClient } from '../e2ee-member-client';
import { StoredDeviceProofSigner } from '../device-proof-signer';
import { resumeDeviceMember } from '../device-member';
import { DeviceMemberKeyring } from '../e2ee-keyring';
import { declares, E2EE_MEMBER_KEM_EPOCH_CAPABILITY } from '../capabilities-client';
import type { DaemonScope } from './scope';

/** The device member: its client and its start on a paired device (#926). */

export function memberClient(daemonScope: DaemonScope, record: DeviceRecord, signal?: AbortSignal): E2eeMemberClient {
  const { config, daemonState } = daemonScope;
  const identity = enrollmentIdentityOf(record);
  return new E2eeMemberClient({
    serverUrl: config.serverUrl,
    auth: daemonState.auth,
    signer: new StoredDeviceProofSigner({
      auth: daemonState.auth, tenantId: identity.tenantId, productId: config.productId, keyId: identity.proofKeyId, keyEpoch: identity.proofKeyEpoch,
    }),
    ...(signal === undefined ? {} : { signal }),
  });
}

/**
 * M5 batch-3 (workstream 2): the ONE graceful-shutdown sequence, shared by
 * every path that stops this daemon while it might have active tasks —
 * closes the M5 ledger item "SIGTERM path doesn't send task.fail". Before
 * this, `stop()` and `performControlShutdown` were two INDEPENDENT
 * implementations: `stop()` just dropped the connection outright with no
 * notion of active tasks at all, so the OS-signal path
 * (`bin/commands/start.ts`'s SIGINT/SIGTERM handler -> this daemon's own
 * public `stop()`) never sent `task.fail` for whatever was still running.
 * Now there is exactly one teardown sequence, and every caller (`stop()`,
 * `unpair()` via `stop()`, and `performControlShutdown`) shares it: stop
 * accepting new offers -> best-effort interrupt+fail every active task,
 * over the STILL-OPEN connection (`TaskRunner.shutdownActiveTasks`,
 * deadline-bounded by `config.shutdownGraceMs` — default
 * `SHUTDOWN_TASK_TEARDOWN_DEADLINE_MS` — so a hung task teardown can never
 * block this daemon from actually stopping) -> bounded wait for that
 * outbox to actually drain (finding F5(b)) -> close the connection / stop
 * the auth renewal timer / stop serving control RPCs -> release the
 * store-mutation lease -> remove the control socket/token files (that last
 * split is an ordering INVARIANT, not a detail — see the comment at the
 * end of this function).
 *
 * CRITICAL preservation (M4 Phase 2 fix, unchanged by this refactor): the
 * connection must not close until AFTER `shutdownActiveTasks` has actually
 * enqueued its `task.fail`(s) — see `performControlShutdown`'s own doc
 * comment for the exact regression (`start.ts` used to wake on the earlier
 * `shutdown-requested` event and race `daemon.stop()` ahead of the
 * still-in-flight send) this ordering fixes. That ordering is unchanged
 * here: stopAcceptingOffers -> shutdownActiveTasks -> THEN connection
 * teardown, for every caller alike, including the OS-signal path that
 * previously skipped straight to connection teardown.
 *
 * Idempotent: a second call (e.g. `performControlShutdown`'s own internal
 * call, followed by `bin/commands/start.ts`'s subsequent `daemon.stop()`
 * once `shutdown-complete` wakes it — see that file's own doc comment)
 * finds `runner`'s active-task map already empty (the first call's own
 * `finish()`s already deleted every entry), so `shutdownActiveTasks` sends
 * nothing the second time; `stopAcceptingOffers` is already idempotent by
 * its own contract; `connection.stop()` is documented idempotent
 * (`connection-manager.ts`); and `controlServerHandle` is reassigned to
 * `undefined` after the first close, so a second call's `?.close()` is a
 * no-op. (When the first call kept the lease — see the split teardown at
 * the end of this function — the handle deliberately survives instead,
 * already stopped serving; both of its stages are themselves idempotent,
 * so the retry that finally releases the lease is what removes the
 * socket/token files.) See `daemon-control-socket.test.ts`'s "REGRESSION
 * (gatekeeper-caught)" test for exactly this double-teardown shape (a
 * control-socket shutdown followed by `runStartCommand`'s own
 * `daemon.stop()`), which must neither double-fail a task nor throw.
 */
/** Resume this enrollment's member off the start path; shutdown and re-pair abort it. */
export function startDeviceMember(daemonScope: DaemonScope, record: DeviceRecord): void {
  const { daemonState, memberRecords, memberClient, logMember, applyCapabilityDeclaration } = daemonScope;
  // Points pass to the immediately next run only, even when its resume finds no member.
  const carried = daemonState.carriedFreshness;
  daemonState.carriedFreshness = undefined;
  if (memberRecords === undefined) return;
  const abort = new AbortController();
  const options = {
    records: memberRecords, client: memberClient(record, abort.signal), tenantId: record.tenantId, deviceId: record.deviceId, log: logMember,
    signal: abort.signal,
  };
  daemonState.memberAbort = abort;
  daemonState.memberResuming = true;
  daemonState.memberResume = resumeDeviceMember(options).then((session) => {
    if (abort.signal.aborted) return;
    daemonState.memberResuming = false;
    if (session === undefined) return;
    const member = new DeviceMemberKeyring(session, {
      ...options,
      carried,
      kemRotation: () => daemonState.deploymentDeclaration !== undefined && declares(daemonState.deploymentDeclaration, E2EE_MEMBER_KEM_EPOCH_CAPABILITY),
      onLost: () => {
        if (daemonState.deviceMember === member) applyCapabilityDeclaration(daemonState.deploymentDeclaration);
      },
    });
    daemonState.deviceMember = member;
    daemonState.activateSealedTasks?.(member);
    applyCapabilityDeclaration(daemonState.deploymentDeclaration);
    console.info(`[byok/client] E2EE member ${session.member.memberId} verified at chain seq ${session.state.head!.seq}`);
  }, (error: unknown) => {
    if (abort.signal.aborted) return;
    daemonState.memberResuming = false;
    logMember(`E2EE member resume failed; E2EE stays off: ${error instanceof Error ? error.message : String(error)}`);
  });
}
