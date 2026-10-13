import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Guards the wiring of scripts/vitest/tmp-root.mjs (the vitest globalSetup in
// vitest.config.ts): workers must resolve os.tmpdir() to the short per-run root,
// otherwise tests leak scratch dirs into the real TMPDIR and macOS Unix-socket
// paths can exceed the 104-byte sun_path limit.
describe('per-run temp root', () => {
  it('points os.tmpdir() at the short per-run root', () => {
    const dir = tmpdir();
    expect(path.basename(dir)).toMatch(/^byok-t-/);
    if (process.platform !== 'win32') {
      expect(path.dirname(dir)).toMatch(/^(\/private)?\/tmp$/);
      // Leaves ~70 bytes for the store path and socket name under the 104-byte limit.
      expect(Buffer.byteLength(dir)).toBeLessThanOrEqual(32);
    }
  });
});
