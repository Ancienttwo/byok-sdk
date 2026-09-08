import { promises as fs, appendFileSync } from 'node:fs';
import { beforeEach, afterEach, expect, vi } from 'vitest';
const nativeOpen = fs.open.bind(fs);
let syncCalls = 0;
let addedDelayMs = 0;
let realSyncMs = 0;
beforeEach(() => {
  syncCalls = 0; addedDelayMs = 0; realSyncMs = 0;
  fs.open = async (...args) => {
    const handle = await nativeOpen(...args);
    if (String(args[0]).endsWith('.jsonl')) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        syncCalls++;
        const waitStart = performance.now();
        await new Promise(resolve => setTimeout(resolve, 21));
        addedDelayMs += performance.now() - waitStart;
        const ioStart = performance.now();
        try { return await sync(); } finally { realSyncMs += performance.now() - ioStart; }
      };
    }
    return handle;
  };
});
afterEach(() => {
  appendFileSync(process.env.DOCTOR_PROFILE_OUTPUT!, JSON.stringify({test: expect.getState().currentTestName, syncCalls, addedDelayMs, realSyncMs}) + '\n');
});
