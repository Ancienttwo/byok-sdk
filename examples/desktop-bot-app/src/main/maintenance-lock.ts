/**
 * Process-wide mutex for S1 Host maintenance windows (`offerInstall`,
 * `shell.restore`, `shell.startFresh`). Held from before Host stop through S1
 * helper completion and sealed once a terminal `relaunch` or `quitAndInstall`
 * handover begins so no second helper or restart can overlap.
 */
export class MaintenanceBusyError extends Error {
  constructor() {
    super('Another recovery action is running');
    this.name = 'MaintenanceBusyError';
  }
}

export interface MaintenanceLock {
  run<T>(action: (handover: () => void) => Promise<T>): Promise<T>;
}

export function createMaintenanceLock(): MaintenanceLock {
  let busy = false;
  let handedOver = false;
  return {
    async run<T>(action: (handover: () => void) => Promise<T>): Promise<T> {
      if (busy || handedOver) throw new MaintenanceBusyError();
      busy = true;
      try {
        return await action(() => {
          handedOver = true;
        });
      } finally {
        if (!handedOver) busy = false;
      }
    },
  };
}
