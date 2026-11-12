/**
 * Main's answers to the shell domain (`src/bridge/domains/shell.ts`): what the
 * window shows about the Host, and the recovery actions (#1499 D3, D4; #1917).
 * Each action stops the Host first, and the app relaunches after it, so the new
 * Host prechecks whatever the action left.
 */
import type { MethodHandlers } from '../bridge/domain.ts';
import type { ShellMethods } from '../bridge/domains/shell.ts';
import { BridgeError, type SupervisedHostState } from '../bridge/protocol.ts';
import { START_FRESH_COMMAND, type StartFreshReceipt } from '../recovery/protocol.ts';
import { completeSnapshot, restoreSnapshot, stampOf, type StoreLayout } from '../recovery/stores.ts';
import { askHostCommand, type CommandChild } from './host-command.ts';

export interface ShellDependencies {
  readonly layout: StoreLayout;
  /** This app's version: restore offers the snapshot this version wrote before an update. */
  readonly version: string;
  readonly hostState: () => SupervisedHostState | undefined;
  /** Stops the Host and resolves once it closed its stores. */
  readonly stopHost: () => Promise<void>;
  /** Spawns the Host executable with these arguments. */
  readonly spawnHostCommand: (args: readonly string[]) => CommandChild;
  /** Restarts the app, after showing `failure` when the action failed. */
  readonly relaunch: (failure?: Error) => void;
  readonly now: () => Date;
}

const noParams = (method: string, params: unknown) => {
  if (params !== undefined) throw new BridgeError('invalid_params', `${method} takes no params`);
};

/**
 * Runs `action` with the Host stopped, then relaunches the app, showing a failure first. A Host that failed to stop
 * relaunches too: main's supervisor has stopped supervising, and the next launch shows what the stores are.
 */
async function withHostStopped<T>(deps: ShellDependencies, action: () => Promise<T>): Promise<T> {
  let result: T;
  try {
    await deps.stopHost();
    result = await action();
  } catch (error) {
    deps.relaunch(error as Error);
    throw error;
  }
  deps.relaunch();
  return result;
}

const stoppedOnly = (state: SupervisedHostState | undefined): state is Extract<SupervisedHostState, { state: 'stopped' }> => state?.state === 'stopped';

export function shellHandlers(deps: ShellDependencies): MethodHandlers<ShellMethods> {
  // The window reads its state after every Host hint; the snapshot of this version only changes in an update, which
  // quits the app. A failed read is not kept, so the next hint reads again.
  let restoreOffer: Promise<{ version: string } | null> | undefined;
  const offer = () => {
    restoreOffer ??= completeSnapshot(deps.layout, deps.version).then(snapshot => (snapshot === undefined ? null : { version: deps.version }));
    restoreOffer.catch(() => { restoreOffer = undefined; });
    return restoreOffer;
  };
  // One recovery action at a time: a second one (or a second click) is refused while the first moves stores, so the
  // relaunch after one never cuts the other between renames.
  let busy = false;
  const exclusive = async <T>(action: () => Promise<T>): Promise<T> => {
    if (busy) throw new Error('Another recovery action is running');
    busy = true;
    try {
      return await action();
    } finally {
      busy = false;
    }
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
      return exclusive(async () => {
        if (!stoppedOnly(deps.hostState())) throw new Error('Restore is offered only while the Host is stopped');
        // Checked before the Host stops, so a missing snapshot leaves the Host as it is.
        if (await completeSnapshot(deps.layout, deps.version) === undefined) throw new Error(`No complete snapshot of version ${deps.version} to restore`);
        return withHostStopped(deps, async () => ({ asidePath: await restoreSnapshot(deps.layout, deps.version, stampOf(deps.now())) }));
      });
    },
    'shell.startFresh': async params => {
      noParams('shell.startFresh', params);
      return exclusive(async () => {
        const state = deps.hostState();
        if (!stoppedOnly(state) || !state.storeRefused) throw new Error('Start fresh is offered only while the Host is stopped on a refused store');
        return withHostStopped(deps, async () => {
          // Without a receipt nobody knows how far the command got: the aside names show what moved.
          const unknown = (message: string) => new Error(`Start fresh did not report: ${message}. Look for *.aside-* beside the store directories`);
          const { receipt, code } = await askHostCommand(deps.spawnHostCommand([START_FRESH_COMMAND, stampOf(deps.now())]), '', unknown);
          const answer = receipt as unknown as StartFreshReceipt;
          // The app never deletes the OS enrollment entry itself: a refused clear points to the SDK's doctor.
          if (!answer.ok) {
            // The SDK can delete the credential and then fail to remove device.json; a second start fresh finishes that clear.
            const partial = answer.code === 'clear_failed' ? ' The enrollment may already be gone; starting fresh again recovers.' : '';
            throw new Error(`Start fresh refused (${answer.code}): ${answer.message}. ${answer.movedBack
              ? 'The stores are back where they were.' : 'Some stores are still aside, as listed.'}${partial} byok-agent doctor shows the device enrollment.`);
          }
          if (code !== 0) throw unknown(`it exited with code ${code} after its receipt`);
          return { moved: answer.moved };
        });
      });
    },
  };
}
