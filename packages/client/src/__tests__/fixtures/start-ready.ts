import { onTestFailed } from 'vitest';

/**
 * Awaits `runStartCommand`'s `onReady` instead of polling a flag: `ready(run)`
 * resolves when `onReady` fires and rejects if `run` settles first, so a
 * start that fails fails the wait with its own error. Like the other test
 * waits it has no deadline of its own; the test timeout bounds it.
 */
export function readyGate(): { onReady: () => void; ready: (run: Promise<unknown>) => Promise<void> } {
  let markReady!: () => void;
  let signalled = false;
  const readySignal = new Promise<void>((resolve) => { markReady = resolve; });
  return {
    onReady: () => {
      signalled = true;
      markReady();
    },
    ready: (run) => {
      onTestFailed(() => {
        if (!signalled) console.error('readyGate: runStartCommand never called onReady');
      });
      return new Promise((resolve, reject) => {
        void readySignal.then(resolve);
        run.then(() => reject(new Error('runStartCommand settled before onReady')), reject);
      });
    },
  };
}
