import { assertServerUrlAllowed, formatServerUrl } from '../url';
import { type DeviceEnrollment, type DeviceRecord, DeviceRecordRePairRequiredError } from '../store';
import { checkVerificationSecret, enrollDeviceMember } from '../device-member';
import { acquireDaemonOwner } from '../daemon-owner';
import { AgentEgressController } from '../agent-egress-controller';
import { PairedWithoutMemberError } from './support';
import type { DaemonScope } from './scope';
import { runAuthOperation } from './lifecycle';

/** Pairing and unpairing the device, each under the daemon owner lease (#926). */

/**
 * M5: `assertServerUrlAllowed`'s call site — see that function's own doc
 * comment (`url.ts`) for why `pair()`/`start()` are the right (and only
 * needed) two places to call it from. Checked WITHOUT the escape hatch
 * FIRST, deliberately: that is the only way to tell whether
 * `dangerouslyAllowInsecureRemote` actually changed the outcome (as
 * opposed to being set but inert, e.g. against a `serverUrl` that was
 * already loopback) — only a hatch that genuinely let something through
 * deserves the loud warning below, emitted via the exact same
 * `console.warn('[byok/client] ...')` convention this file already uses
 * for its other non-fatal, operator-facing warnings (see the
 * control-socket bind-failure warning in `start()`).
 *
 * F2 (fixed here): `config.dangerouslyAllowInsecureRemote` being set only
 * means "forgive a plaintext-to-non-loopback rejection" — it does NOT mean
 * "forgive literally any rejection this gate can ever produce." An
 * unsupported scheme (e.g. `ftp:`) or a `serverUrl` that fails to parse as
 * a URL at all is refused by `assertServerUrlAllowed` UNCONDITIONALLY,
 * regardless of `dangerouslyAllowInsecureRemote` (see that function's own
 * doc comment) — the previous version of this catch block forwarded the
 * hatch's boolean straight past that distinction and warned-and-proceeded
 * for EVERY rejection once the flag was set. Fixed by re-running the exact
 * same check WITH the hatch passed through once the flag is confirmed set;
 * only a second call that ALSO passes proves the hatch genuinely covers
 * this specific rejection and earns the warn-and-proceed below. If the
 * second call throws too, that throw propagates out of this function
 * unchanged (nothing here catches it) — correctly, since the hatch was
 * never going to cover this rejection in the first place.
 */
export function checkServerUrl(daemonScope: DaemonScope): void {
  const { config } = daemonScope;
  try {
    assertServerUrlAllowed(config.serverUrl);
  } catch (err) {
    if (!config.dangerouslyAllowInsecureRemote) throw err;
    assertServerUrlAllowed(config.serverUrl, { dangerouslyAllowInsecureRemote: true });
    const reason = err instanceof Error ? err.message : String(err);
    console.warn(
      `[byok/client] WARNING: dangerouslyAllowInsecureRemote is set — proceeding with an insecure server URL (${formatServerUrl(config.serverUrl)}). ` +
        `Device credentials and task data will be sent in the clear to a non-loopback host. This should never be used in a real ` +
        `deployment. (${reason})`,
    );
  }
}

export async function pair(daemonScope: DaemonScope, pairingCode: string, options?: { readonly verificationSecret?: string }): Promise<DeviceEnrollment> {
  const { checkServerUrl, memberRecords, pairUnderLease } = daemonScope;
  checkServerUrl();
  const verificationSecret = options?.verificationSecret === undefined ? undefined : checkVerificationSecret(options.verificationSecret);
  if (verificationSecret !== undefined && memberRecords === undefined) {
    throw new TypeError('an E2EE pairing needs the OS credential custody; this daemon uses an injected credential backend');
  }
  // Serialize every lifecycle mutation, not only pair/pair. A process-local
  // operation may borrow the daemon's retained cross-process lease, so pair,
  // start, stop, control shutdown and unpair must never decide independently
  // who releases that shared lease.
  const record = await runAuthOperation(daemonScope, () => pairUnderLease(pairingCode, verificationSecret));
  return Object.freeze({ deviceId: record.deviceId });
}

export async function pairUnderLease(daemonScope: DaemonScope, pairingCode: string, verificationSecret?: string): Promise<DeviceRecord> {
  const {
    daemonState, storeDir, config, egressPolicy, runShutdownSequence, cursorStore, observer,
    memberRecords, memberClient, logMember,
  } = daemonScope;
  const wasRunning = daemonState.daemonStarted;
  if (wasRunning) daemonState.tenantRebinding = true;
  // Pairing persists device.json. It intentionally does not arm proactive
  // renewal (AuthManager.loadExisting does that under start()'s lease), so a
  // short-lived pair command can release ownership once the write lands.
  const acquiredHere = daemonState.daemonOwnerLease === undefined;
  if (acquiredHere) daemonState.daemonOwnerLease = await acquireDaemonOwner(storeDir, 'daemon');
  // Finding F5: capture whatever device is currently on disk for this
  // serverUrl (if any) BEFORE pairing — `auth.pair()` mints/persists a
  // brand new deviceId (the server always does, even on a same-keypair
  // re-pair; see docs/protocol.md §6.3) and there would be no way to
  // recover the outgoing deviceId afterward to know whose cursor to clear.
  // Reading straight from `store` (not `auth.deviceId`) works whether or
  // not `start()`/`loadExisting()` ran in this process before `pair()`.
  let replacementPersisted = false;
  try {
    let previous: DeviceRecord | undefined;
    try {
      previous = await daemonState.auth.readCurrent();
    } catch (error) {
      // Pairing may replace a legacy/tampered record, but must not derive a
      // cursor/device identity from an untrusted file.
      if (!(error instanceof DeviceRecordRePairRequiredError)) throw error;
    }
    const record = await daemonState.auth.pair(pairingCode);
    replacementPersisted = true;
    // No stopped daemon operation may continue using a superseded binding
    // between re-pair and the next start. startUnderLease will construct the
    // bound controller only from the newly loaded DeviceRecord.
    if (config.agentEgress !== undefined) {
      // TaskRunner owns the previous controller by reference for this run;
      // deactivate it before the new record can be followed by shutdown
      // terminal/progress activity.
      daemonState.agentEgress.deactivate();
      daemonState.agentEgress = new AgentEgressController({ policy: egressPolicy });
    }
    if (wasRunning) {
      // The pair response has replaced device.json, so the running daemon's
      // closures are no longer allowed to handle work under the old record.
      // Completing this shutdown before pair() resolves makes restart an
      // explicit, fresh load of the new authenticated binding.
      await runShutdownSequence('re-pairing enrollment binding');
      daemonState.tenantRebinding = false;
    }
    if (previous && previous.deviceId !== record.deviceId) {
      await cursorStore.clear(config.serverUrl, previous.deviceId);
    }
    observer.notePaired(record.deviceId);
    // A new enrollment is a new member (§7.5); the previous one's entries are void (10b).
    daemonState.carriedFreshness = undefined;
    try {
      await memberRecords?.clear();
    } catch (error) {
      throw new PairedWithoutMemberError(record.deviceId, 'the previous E2EE member entries could not be deleted', error);
    }
    if (verificationSecret !== undefined) {
      try {
        await enrollDeviceMember({
          records: memberRecords!, client: memberClient(record), tenantId: record.tenantId, deviceId: record.deviceId,
          verificationSecret, log: logMember,
        });
      } catch (error) {
        throw new PairedWithoutMemberError(record.deviceId, 'its E2EE member enrollment failed; re-pair to enable E2EE', error);
      }
    }
    if (acquiredHere) {
      await daemonState.daemonOwnerLease?.release();
      daemonState.daemonOwnerLease = undefined;
    }
    return record;
  } catch (err) {
    if (wasRunning && !replacementPersisted) daemonState.tenantRebinding = false;
    if (acquiredHere) {
      await daemonState.daemonOwnerLease?.release();
      daemonState.daemonOwnerLease = undefined;
    }
    throw err;
  }
}

/**
 * M3-2a: clears this device's persisted identity and disconnects. Safe at
 * any point in the lifecycle:
 *  - `stop()` is a no-op beyond clearing state if `start()` was never
 *    called (`connection` stays `undefined`; `auth.stop()` on a
 *    never-renewed `AuthManager` just no-ops its unset timer).
 *  - `store.clear()` (`fs.rm(..., { force: true })`) is a no-op if this
 *    device was never paired.
 * Reads the on-disk record BEFORE clearing (mirrors `pair()`'s own F5
 * pattern above) so the cursor hygiene cleanup below knows which device's
 * entry to remove; rebuilding `auth` (see `buildAuthManager`) is what
 * actually makes the NEXT `start()` require a fresh `pair()` — clearing
 * `store` alone would leave a same-process `AuthManager`'s cached
 * in-memory record still usable.
 */
export async function unpair(daemonScope: DaemonScope): Promise<void> {
  const { daemonState, runLifecycleMutation, unpairUnderLease } = daemonScope;
  // codex round-2 F1: same synchronous arming as `stop()` above — an `unpair`
  // queued behind an in-progress `start()`/`pair()` must not leave the socket
  // minting while it waits its turn in the lifecycle queue. Unpair is the
  // exact path where this matters most: it tears the daemon down and then
  // clears `device.json`, so any assertion minted in the queue-wait window
  // would be for a device that is being unpaired.
  daemonState.shuttingDown = true;
  await runLifecycleMutation(unpairUnderLease);
}

export async function unpairUnderLease(daemonScope: DaemonScope): Promise<void> {
  const {
    runShutdownSequence, storeDir, daemonState, memberRecords, store, buildAuthManager, cursorStore,
    config, observer,
  } = daemonScope;
  // The outer lifecycle slot prevents pair/start/control shutdown from
  // entering while teardown and destructive credential cleanup span two
  // cross-process lease acquisitions.
  await runShutdownSequence('operator');
  // Teardown stopped the auth manager; unpair still reads the identity it removes.
  daemonState.auth.resume();
  // stop() releases only after every daemon writer settles. Reacquire before
  // destructive identity cleanup; if another daemon won the gap, fail
  // closed rather than clearing state under it.
  const cleanupLease = await acquireDaemonOwner(storeDir, 'daemon');
  try {
    // The identity being removed is read under the same lease as both the
    // device and cursor mutations. A pair that wins stop()'s release gap is
    // therefore either wholly before this cleanup (and is fully removed) or
    // wholly after it; stale pre-lease identity can never drive cleanup.
    let current: DeviceRecord | undefined;
    try {
      current = await daemonState.auth.readCurrent();
    } catch (error) {
      if (!(error instanceof DeviceRecordRePairRequiredError)) throw error;
    }
    // The member entries go first: if their deletion fails, the device
    // stays paired, and the unpair reports the failure.
    daemonState.carriedFreshness = undefined;
    await memberRecords?.clear();
    try {
      await store.credentials.clear();
    } catch {
      // The OS credential remains the sole secret authority. Leave the
      // metadata and in-memory auth binding observable until its deletion
      // succeeds; never report an unpair that did not clear that authority.
      throw new Error('device credential could not be cleared; enrollment remains paired and fail-closed');
    }
    try {
      await store.remove();
    } catch (error) {
      // Secret clearance won but metadata cleanup lost. Rebuild auth so this
      // process cannot continue with the previous cache; the surviving
      // projection subsequently reads as re-pair-required.
      daemonState.auth = buildAuthManager();
      throw error;
    }
    if (current) await cursorStore.clear(config.serverUrl, current.deviceId);
  } finally {
    await cleanupLease.release();
  }
  daemonState.auth = buildAuthManager();
  observer.noteUnpaired();
}
