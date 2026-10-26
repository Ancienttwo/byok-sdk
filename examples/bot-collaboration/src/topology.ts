import { hash, type LedgerState } from '@byok-sdk/example-host-execution-core';
import { stateOf, type CollaborationState } from './model';
import type { HomeOperation } from './team-model';
import { CommitConflict } from './rules/commit';
import { DEVICE_NOT_BOUND, DEVICE_SWITCHING, type SyncRefusal } from './rules/commands';

// The L side of the §4.1 owner switch (#957). L is the old owner: it freezes one device, drains it, and then either hands it
// to H or resumes it. The record is per device, as §4.1 records the mode, and one L Host can own Bots on two devices.

/** The L owner record of one device. A device with no row is `{ mode: 'L', revision: 0 }`: a device defaults to L. */
export interface DeviceTopology { mode: 'L' | 'H'; revision: number; switching?: 'H' }
/** The device's open work that a switch must drain before it commits. */
export interface SwitchWork {
  /** Open K4 intents whose execution names the device: Bot Turns, routine occurrences and Host intents. */
  intents: string[];
  /** Turns of the device's Bots with no conclusion and no intent. */
  turns: string[];
  /** Open input batches of the device's Bots. Each becomes a Turn when it seals. */
  batches: string[];
  /** Agent home writes of the device's Bots that were sent and have no terminal readback yet. */
  homeOperations: number[];
}

/** The device is frozen for an owner switch. A retry after the switch may succeed. */
export class DeviceSwitchingError extends Error {
  readonly code = DEVICE_SWITCHING;
  constructor(readonly deviceId: string, readonly target: 'H', readonly revision: number) {
    super(`Device ${deviceId} is switching to ${target}`);
    this.name = 'DeviceSwitchingError';
  }
}
/** The device's owner is now H. L never creates work on it again. Same code and reason as H's `DeviceBindingError`. */
export class DeviceModeError extends Error {
  readonly code = DEVICE_NOT_BOUND;
  readonly reason = 'mode' as const;
  constructor(readonly deviceId: string, readonly mode: 'H', readonly revision: number) {
    super(`Device ${deviceId} is owned by ${mode}`);
    this.name = 'DeviceModeError';
  }
}

/** A device id is the Host's string, so the table is read and written through own properties only, never `__proto__`. */
function recordOf(state: CollaborationState, deviceId: string): DeviceTopology | undefined {
  return state.topology && Object.hasOwn(state.topology, deviceId) ? state.topology[deviceId] : undefined;
}
export function deviceTopology(state: CollaborationState, deviceId: string): DeviceTopology {
  const row = recordOf(state, deviceId);
  return row ? { ...row } : { mode: 'L', revision: 0 };
}
/** The sync refusal of the device (#956 `deviceRefusal`), or undefined when L may create work on it. */
export function deviceRefusal(state: CollaborationState, deviceId: string): Extract<SyncRefusal, 'mode' | 'switching'> | undefined {
  const row = recordOf(state, deviceId);
  return row?.mode === 'H' ? 'mode' : row?.switching ? 'switching' : undefined;
}
export function botDeviceRefusal(state: CollaborationState, botId: string): ReturnType<typeof deviceRefusal> {
  const bot = state.team.bots[botId];
  return bot && deviceRefusal(state, bot.execution.deviceId);
}
/** Throws the typed refusal when L must not create work on the device. */
export function admitDevice(state: CollaborationState, deviceId: string): void {
  const row = recordOf(state, deviceId);
  if (row?.mode === 'H') throw new DeviceModeError(deviceId, row.mode, row.revision);
  if (row?.switching) throw new DeviceSwitchingError(deviceId, row.switching, row.revision);
}
/** An unknown Bot or room is left to the command, which refuses it. */
export function admitBot(state: CollaborationState, botId: string): void {
  const bot = state.team.bots[botId];
  if (bot) admitDevice(state, bot.execution.deviceId);
}

export function switchWork(s: LedgerState, deviceId: string): SwitchWork {
  const state = stateOf(s.application), onDevice = (botId: string) => state.team.bots[botId]?.execution.deviceId === deviceId;
  return {
    intents: Object.values(s.intents).filter(intent => !intent.conclusion && intent.execution.deviceId === deviceId).map(intent => intent.key),
    turns: Object.values(state.turns).filter(turn => !turn.conclusion && !s.intents[hash(turn.id)] && onDevice(turn.botId)).map(turn => turn.id),
    batches: Object.values(state.inputBatches ?? {}).filter(batch => batch.state === 'open' && onDevice(batch.botId)).map(batch => batch.id),
    // A write that was never sent moves with the exported state.
    homeOperations: state.team.homeOperations.filter(op => op.status === 'pending' && homeSent(op) && op.request.deviceId === deviceId)
      .map(op => op.sequence),
  };
}
/**
 * A home write that may have reached the server: marked before its first send, or (in a ledger written before the mark)
 * with the retry time that a send sets. The `retryAt` branch, and the same read in `checkCollaboration` (`migration.ts`),
 * go with Bot collaboration state version 4 (`model.ts` accepts only 3), whose loader refuses a version 3 ledger or
 * marks such a write `sent` when it upgrades one.
 */
export function homeSent(op: HomeOperation): boolean {
  return op.sent === true || op.retryAt !== undefined;
}
export function switchDrained(work: SwitchWork): boolean {
  return !work.intents.length && !work.turns.length && !work.batches.length && !work.homeOperations.length;
}

/**
 * One switch step on the expected revision. Each step raises the revision, so every later step names the one it expects.
 * `freeze`: an L device that is not switching. `commit` and `abort`: a frozen device. A stale revision is a `CommitConflict`.
 */
export function switchStep(s: LedgerState, deviceId: string, expectedRevision: number, step: 'freeze' | 'commit' | 'abort'): DeviceTopology {
  const state = stateOf(s.application), row = deviceTopology(state, deviceId);
  if (row.revision !== expectedRevision) {
    throw new CommitConflict('stale_revision', `Device ${deviceId} is at topology revision ${row.revision}, not ${expectedRevision}`);
  }
  if (row.mode !== 'L') throw new DeviceModeError(deviceId, row.mode, row.revision);
  if (step === 'freeze' ? row.switching : !row.switching) throw new Error(`Device ${deviceId} is ${row.switching ? 'already' : 'not'} switching`);
  if (step === 'commit' && !switchDrained(switchWork(s, deviceId))) throw new Error(`Device ${deviceId} still has open work`);
  const next: DeviceTopology = step === 'freeze' ? { mode: 'L', revision: row.revision + 1, switching: 'H' }
    : { mode: step === 'commit' ? 'H' : 'L', revision: row.revision + 1 };
  Object.defineProperty(state.topology ??= {}, deviceId, { value: next, enumerable: true, writable: true, configurable: true });
  return { ...next };
}

/** A restart reads every row before any pass. A malformed row fails closed. */
export function checkTopology(state: CollaborationState): void {
  for (const [deviceId, row] of Object.entries(state.topology ?? {})) {
    const keys = Object.keys(row ?? {}).sort().join(',');
    const valid = !!row && (row.mode === 'L' || row.mode === 'H') && Number.isSafeInteger(row.revision) && row.revision > 0
      && (row.switching === undefined ? keys === 'mode,revision' : row.switching === 'H' && row.mode === 'L' && keys === 'mode,revision,switching');
    if (!valid) throw new Error(`Invalid topology record for device ${deviceId}`);
  }
}
