/**
 * Process-wide mutex for S1 Host maintenance windows (`offerInstall`,
 * `shell.restore`, `shell.startFresh`). Held from before Host stop through S1
 * helper completion, distinguishes pending external installer takeover from
 * confirmed terminal handover (`relaunch` / `relaunchAndQuit` / confirmed
 * `quitAndInstall`), and is awaited by normal `before-quit` so app exit never
 * releases the single-instance lock ahead of an active S1 helper.
 */
export class MaintenanceBusyError extends Error {
  constructor() {
    super('Another recovery action is running');
    this.name = 'MaintenanceBusyError';
  }
}

export interface HandoverControls {
  /** Marks an external installer takeover as pending (still blocks concurrent maintenance, not yet confirmed). */
  beginPending(): void;
  /** Cancels a pending handover when the external installer did not take over. */
  cancelPending(): void;
  /** Confirms terminal handover (seals the lock permanently and lets intentional app quit pass). */
  confirm(): void;
}

export interface MaintenanceLock {
  run<T>(action: (handover: HandoverControls) => Promise<T>): Promise<T>;
  isHandedOver(): boolean;
  isQuitting(): boolean;
  /**
   * Called by `before-quit`: returns true if handover is already confirmed,
   * or promotes a `pending` installer handover to `confirmed`, allowing
   * intentional quit/install to proceed without `preventDefault()`.
   */
  allowQuitHandover(): boolean;
  /** Enters app quit, waiting for any in-flight maintenance work to finish before quitting. */
  beginQuit(): Promise<'quit' | 'handed-over'>;
}

export interface BeforeQuitOptions {
  readonly maintenanceLock: MaintenanceLock;
  readonly stopHost: () => Promise<void>;
  readonly exit: (code: number) => void;
  readonly logError: (message: string) => void;
}

type HandoverState = 'none' | 'pending' | 'confirmed';

export function createMaintenanceLock(): MaintenanceLock {
  let busy = false;
  let handover: HandoverState = 'none';
  let quitting = false;
  let inFlight: Promise<void> | undefined;
  const currentHandover = (): HandoverState => handover;
  return {
    async run<T>(action: (controls: HandoverControls) => Promise<T>): Promise<T> {
      if (busy || currentHandover() !== 'none' || quitting) throw new MaintenanceBusyError();
      busy = true;
      let finish!: () => void;
      inFlight = new Promise<void>(resolve => {
        finish = resolve;
      });
      try {
        return await action({
          beginPending: () => {
            if (handover === 'none') handover = 'pending';
          },
          cancelPending: () => {
            if (handover === 'pending') handover = 'none';
          },
          confirm: () => {
            handover = 'confirmed';
          },
        });
      } finally {
        inFlight = undefined;
        if (currentHandover() !== 'confirmed') {
          handover = 'none';
          busy = false;
        }
        finish();
      }
    },
    isHandedOver(): boolean {
      return handover === 'confirmed';
    },
    isQuitting(): boolean {
      return quitting;
    },
    allowQuitHandover(): boolean {
      if (handover === 'confirmed') return true;
      if (handover === 'pending') {
        handover = 'confirmed';
        return true;
      }
      return false;
    },
    async beginQuit(): Promise<'quit' | 'handed-over'> {
      quitting = true;
      await inFlight;
      return currentHandover() === 'confirmed' ? 'handed-over' : 'quit';
    },
  };
}

/**
 * Coordinates Electron `before-quit` with {@link MaintenanceLock}: intentional
 * post-handover quits (`quitAndInstall` / `relaunchAndQuit`) pass straight
 * through, while normal quits wait for any in-flight S1 helper before stopping
 * the Host and exiting.
 */
export function createBeforeQuitHandler(options: BeforeQuitOptions): (event: { preventDefault(): void }) => void {
  let stopping = false;
  return event => {
    if (options.maintenanceLock.allowQuitHandover()) return;
    event.preventDefault();
    if (stopping) return;
    stopping = true;
    void (async () => {
      const outcome = await options.maintenanceLock.beginQuit();
      if (outcome === 'handed-over') return;
      try {
        await options.stopHost();
        options.exit(0);
      } catch (error) {
        options.logError(`Host shutdown failed: ${(error as Error).message}`);
        options.exit(1);
      }
    })();
  };
}
