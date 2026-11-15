import { onTestFailed, TestRunner } from 'vitest';

const NOT_READY = 'readyGate: runStartCommand never called onReady';

/**
 * Awaits `runStartCommand`'s `onReady` instead of polling a flag: `ready(run)`
 * resolves when `onReady` fires and rejects if `run` settles first, so a
 * start that fails fails the wait with its own error. Like the other test
 * waits it has no deadline of its own. It rejects when Vitest aborts the test
 * on timeout or cancellation, allowing asynchronous cleanup to finish.
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
      const signal = TestRunner.getCurrentTest()!.context.signal;
      onTestFailed(() => {
        if (!signalled) console.error(NOT_READY);
      });
      return new Promise((resolve, reject) => {
        const onAbort = (): void => reject(new Error(NOT_READY));
        if (signal.aborted && !signalled) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
        void readySignal.then(() => {
          signal.removeEventListener('abort', onAbort);
          resolve();
        });
        run.then(() => {
          signal.removeEventListener('abort', onAbort);
          reject(new Error('runStartCommand settled before onReady'));
        }, error => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        });
      });
    },
  };
}
