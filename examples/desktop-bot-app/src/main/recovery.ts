/**
 * Main's answers to the shell domain (`src/bridge/domains/shell.ts`): what the
 * window shows about the Host, and the recovery actions (#1499 D3, D4; #1917;
 * #2459). Recovery actions stop the Host first and delegate store inspection
 * and file moves to the Host executable (S1) before relaunching.
 */
import type { MethodHandlers } from '../bridge/domain.ts';
import type { ShellMethods } from '../bridge/domains/shell.ts';
import { BridgeError, type SupervisedHostState } from '../bridge/protocol.ts';
import {
  RESTORE_COMMAND,
  SNAPSHOT_STATUS_COMMAND,
  START_FRESH_COMMAND,
  stampOf,
  type RestoreReceipt,
  type SnapshotStatusReceipt,
  type StartFreshReceipt,
} from '../recovery/protocol.ts';
import { askHostCommand, type CommandChild, type Receipt } from './host-command.ts';
import type { HandoverControls, MaintenanceLock } from './maintenance-lock.ts';

export interface ShellDependencies {
  /** This app's version: restore offers the snapshot this version wrote before an update. */
  readonly version: string;
  readonly hostState: () => SupervisedHostState | undefined;
  /** Stops the Host and resolves once it closed its stores. */
  readonly stopHost: () => Promise<void>;
  /** Spawns the Host executable with these arguments. */
  readonly spawnHostCommand: (args: readonly string[]) => CommandChild;
  /** Shared process-wide lock held from Host stop through S1 helper completion and terminal handover. */
  readonly maintenanceLock: MaintenanceLock;
  /** Restarts the app, after showing `failure` when the action failed. */
  readonly relaunch: (failure?: Error) => void;
  readonly now: () => Date;
}

const noParams = (method: string, params: unknown) => {
  if (params !== undefined) throw new BridgeError('invalid_params', `${method} takes no params`);
};

/**
 * Confirms the Host is stopped first, then runs S1 `action` and seals the lock
 * into `relaunch`. If `stopHost()` itself fails, S1 `action` is never started
 * and `relaunch` is not called so existing stores remain untouched.
 */
async function withHostStopped<T>(deps: ShellDependencies, handover: HandoverControls, action: () => Promise<T>): Promise<T> {
  await deps.stopHost();
  let result: T;
  try {
    result = await action();
  } catch (error) {
    handover.confirm();
    deps.relaunch(error as Error);
    throw error;
  }
  handover.confirm();
  deps.relaunch();
  return result;
}

async function runHostReceipt<T extends Receipt>(
  spawnHostCommand: (args: readonly string[]) => CommandChild,
  args: readonly string[],
  unknown: (message: string) => Error,
): Promise<T> {
  const { receipt, code } = await askHostCommand(spawnHostCommand(args), '', unknown);
  if (receipt.ok && code !== 0) throw unknown(`it exited with code ${code} after its receipt`);
  return receipt as unknown as T;
}

async function querySnapshotStatus(
  spawnHostCommand: (args: readonly string[]) => CommandChild,
  version: string,
): Promise<{ readonly version: string; readonly target: string } | null> {
  const unknown = (message: string) => new Error(`Snapshot status did not report: ${message}`);
  const answer = await runHostReceipt<SnapshotStatusReceipt>(spawnHostCommand, [SNAPSHOT_STATUS_COMMAND, version], unknown);
  if (!answer.ok) throw new Error(answer.message);
  return answer.snapshot;
}

const stoppedOnly = (state: SupervisedHostState | undefined): state is Extract<SupervisedHostState, { state: 'stopped' }> => state?.state === 'stopped';

export function shellHandlers(deps: ShellDependencies): MethodHandlers<ShellMethods> {
  // The window reads its state after every Host hint; the snapshot of this version only changes in an update, which
  // quits the app. A failed read is not kept, so the next hint reads again.
  let restoreOffer: Promise<{ version: string } | null> | undefined;
  const offer = () => {
    restoreOffer ??= querySnapshotStatus(deps.spawnHostCommand, deps.version).then(snapshot => (snapshot === null ? null : { version: snapshot.version }));
    restoreOffer.catch(() => { restoreOffer = undefined; });
    return restoreOffer;
  };
  return {
    'shell.state': async params => {
      noParams('shell.state', params);
      const host = deps.hostState() ?? null;
      try {
        return { host, restore: await offer(), restoreError: null };
      } catch (error) {
        return { host, restore: null, restoreError: (error as Error).message };
      }
    },
    // Offered only while the Host is stopped: a Host that runs on the current data needs no rollback, and a snapshot
    // left by an update that never installed does not turn into a standing offer on the same version.
    'shell.restore': async params => {
      noParams('shell.restore', params);
      return deps.maintenanceLock.run(async handover => {
        if (!stoppedOnly(deps.hostState())) throw new Error('Restore is offered only while the Host is stopped');
        // Checked before stopping/relaunching, so a missing snapshot leaves the Host as it is.
        if (await querySnapshotStatus(deps.spawnHostCommand, deps.version) === null) {
          throw new Error(`No complete snapshot of version ${deps.version} to restore`);
        }
        return withHostStopped(deps, handover, async () => {
          const unknown = (message: string) => new Error(`Restore did not report: ${message}`);
          const answer = await runHostReceipt<RestoreReceipt>(
            deps.spawnHostCommand,
            [RESTORE_COMMAND, deps.version, stampOf(deps.now())],
            unknown,
          );
          if (!answer.ok) {
            throw new Error(`Restore refused (${answer.code}): ${answer.message}. ${answer.movedBack
              ? 'The stores are back where they were.' : 'Some stores remain aside.'}`);
          }
          return { asidePath: answer.asidePath };
        });
      });
    },
    'shell.startFresh': async params => {
      noParams('shell.startFresh', params);
      return deps.maintenanceLock.run(async handover => {
        const state = deps.hostState();
        if (!stoppedOnly(state) || !state.storeRefused) throw new Error('Start fresh is offered only while the Host is stopped on a refused store');
        return withHostStopped(deps, handover, async () => {
          // Without a receipt nobody knows how far the command got: the aside names show what moved.
          const unknown = (message: string) => new Error(`Start fresh did not report: ${message}. Look for *.aside-* beside the store directories`);
          const answer = await runHostReceipt<StartFreshReceipt>(
            deps.spawnHostCommand,
            [START_FRESH_COMMAND, stampOf(deps.now())],
            unknown,
          );
          // The app never deletes the OS enrollment entry itself: a refused clear points to the SDK's doctor.
          if (!answer.ok) {
            // The SDK can delete the credential and then fail to remove device.json; a second start fresh finishes that clear.
            const partial = answer.code === 'clear_failed' ? ' The enrollment may already be gone; starting fresh again recovers.' : '';
            throw new Error(`Start fresh refused (${answer.code}): ${answer.message}. ${answer.movedBack
              ? 'The stores are back where they were.' : 'Some stores are still aside, as listed.'}${partial} byok-agent doctor shows the device enrollment.`);
          }
          return { moved: answer.moved };
        });
      });
    },
  };
}
