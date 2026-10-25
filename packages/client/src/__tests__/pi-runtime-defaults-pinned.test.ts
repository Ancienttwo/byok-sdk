import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// Relative and test-only, like pi-model-catalog-pinned.test.ts: keys has no Pi
// dependency, and the client is where the pinned pi-coding-agent resolves.
import { PI_RUNTIME_DEFAULTS_FILE, renderPiRuntimeDefaults } from '../../../../scripts/keys/generate-pi-model-catalog';
import { PI_DEFAULT_THINKING_LEVEL } from '../../../keys/src/pi-runtime-defaults.generated';
import { PI_THINKING_LEVELS } from '../../../keys/src/pi-model-config';

describe('keys Pi run-time defaults against the pinned pi-coding-agent', () => {
  it('is generated from the pi-coding-agent the client pins, with no drift', async () => {
    // A Windows checkout may convert the file to CRLF; only the content is compared.
    expect(readFileSync(PI_RUNTIME_DEFAULTS_FILE, 'utf8').replaceAll('\r\n', '\n')).toBe(await renderPiRuntimeDefaults());
  });

  it("is one of Pi's thinking levels", () => {
    expect(PI_THINKING_LEVELS).toContain(PI_DEFAULT_THINKING_LEVEL);
  });
});
