/**
 * Process-wide mutex for S1 Host maintenance windows (`offerInstall`,
 * `shell.restore`, `shell.startFresh`). Held from before Host stop through S1
 * helper completion, sealed once a terminal `relaunch` / `quitAndInstall`
 * handover begins, and awaited by normal `before-quit` so app exit never
 * releases the single-instance lock ahead of an active S1 helper.
 */
export class MaintenanceBusyError extends Error {
  constructor() {
    super('Another recovery action is running');
    this.name = 'MaintenanceBusyError';
  }
}

export interface MaintenanceLock {
  run<T>(action: (handover: () => void) => Promise<T>): Promise<T>;
  isHandedOver(): boolean;
  /** Enters app quit, waiting for any in-flight maintenance work to finish before quitting. */
  beginQuit(): Promise<'quit' | 'handed-over'>;
}

export interface BeforeQuitOptions {
  readonly maintenanceLock: MaintenanceLock;
  readonly stopHost: () => Promise<void>;
  readonly exit: (code: number) => void;
  readonly logError: (message: string) => void;
}

export function createMaintenanceLock(): MaintenanceLock {
  let busy = false;
  let handedOver = false;
  let quitting = false;
  let inFlight: Promise<void> | undefined;
  return {
    async run<T>(action: (handover: () => void) => Promise<T>): Promise<T> {
      if (busy || handedOver || quitting) throw new MaintenanceBusyError();
      busy = true;
      let finish!: () => void;
      inFlight = new Promise<void>(resolve => {
        finish = resolve;
      });
      try {
        return await action(() => {
          handedOver = true;
        });
      } finally {
        inFlight = undefined;
        if (!handedOver) busy = false;
        finish();
      }
    },
    isHandedOver(): boolean {
      return handedOver;
    },
    async beginQuit(): Promise<'quit' | 'handed-over'> {
      quitting = true;
      await inFlight;
      return handedOver ? 'handed-over' : 'quit';
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
    if (options.maintenanceLock.isHandedOver()) return;
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
