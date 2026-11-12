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

/** Runs `action` with the Host stopped, then relaunches the app, showing a failure first. */
async function withHostStopped<T>(deps: ShellDependencies, action: () => Promise<T>): Promise<T> {
  await deps.stopHost();
  let result: T;
  try {
    result = await action();
  } catch (error) {
    deps.relaunch(error as Error);
    throw error;
  }
  deps.relaunch();
  return result;
}

export function shellHandlers(deps: ShellDependencies): MethodHandlers<ShellMethods> {
  // The window reads its state after every Host hint; the snapshot of this version only changes in an update, which quits the app.
  let restoreOffer: Promise<{ version: string } | null> | undefined;
  const offer = () => restoreOffer ??= completeSnapshot(deps.layout, deps.version).then(snapshot => (snapshot === undefined ? null : { version: deps.version }));
  return {
    'shell.state': async params => {
      noParams('shell.state', params);
      return { host: deps.hostState() ?? null, restore: await offer() };
    },
    'shell.restore': async params => {
      noParams('shell.restore', params);
      // Checked before the Host stops, so a missing snapshot leaves a running Host alone.
      if (await completeSnapshot(deps.layout, deps.version) === undefined) throw new Error(`No complete snapshot of version ${deps.version} to restore`);
      return withHostStopped(deps, async () => ({ asidePath: await restoreSnapshot(deps.layout, deps.version, stampOf(deps.now())) }));
    },
    'shell.startFresh': async params => {
      noParams('shell.startFresh', params);
      const state = deps.hostState();
      if (state?.state !== 'stopped' || !state.storeRefused) throw new Error('Start fresh is offered only while the Host is stopped on a refused store');
      return withHostStopped(deps, async () => {
        // Without a receipt nobody knows how far the command got: the aside names show what moved.
        const unknown = (message: string) => new Error(`Start fresh did not report: ${message}. Look for *.aside-* beside the store directories`);
        const { receipt, code } = await askHostCommand(deps.spawnHostCommand([START_FRESH_COMMAND, stampOf(deps.now())]), '', unknown);
        const answer = receipt as unknown as StartFreshReceipt;
        // The app never deletes the OS enrollment entry itself: a refused clear points to the SDK's doctor.
        if (!answer.ok) {
          throw new Error(`Start fresh refused (${answer.code}): ${answer.message}. ${answer.movedBack
            ? 'The stores are back where they were.' : 'Some stores are still aside, as listed.'} byok-agent doctor shows the device enrollment.`);
        }
        if (code !== 0) throw unknown(`it exited with code ${code} after its receipt`);
        return { moved: answer.moved };
      });
    },
  };
}
