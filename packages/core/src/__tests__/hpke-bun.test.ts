/**
 * Runs the HPKE conformance probe under Bun — the device daemon is a
 * Bun-compiled binary, so Node-only evidence would not cover the runtime that
 * actually opens sealed secrets.
 *
 * Interpreter lookup mirrors the repository's bun test gate
 * (`packages/client/src/__tests__/support/test-bun-bin.ts`): no candidate →
 * a visible skip; `BYOK_REQUIRE_BUN=1` (set by the CI build-test job, which
 * also names the interpreter through `BYOK_TEST_BUN_BIN`) → absence is a hard
 * failure, never a skip.
 */
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

function isFile(candidate: string | undefined): candidate is string {
  if (candidate === undefined) return false;
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function resolveBun(): string | undefined {
  const explicit = process.env.BYOK_TEST_BUN_BIN;
  if (process.env.BYOK_REQUIRE_BUN === '1' && explicit !== undefined) {
    if (!isFile(explicit)) throw new Error(`BYOK_REQUIRE_BUN=1 and BYOK_TEST_BUN_BIN=${explicit} is missing or not a file`);
    return explicit;
  }
  const found = [explicit, path.join(os.homedir(), '.local/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun'].find(isFile);
  if (found === undefined && process.env.BYOK_REQUIRE_BUN === '1') {
    throw new Error('BYOK_REQUIRE_BUN=1 but no bun interpreter was found');
  }
  return found;
}

const bun = resolveBun();
const probe = fileURLToPath(new URL('./support/hpke-bun-probe.ts', import.meta.url));

describe('HPKE under Bun', () => {
  it.skipIf(bun === undefined)('passes the RFC 9180 oracle, independent interop and sealed round trip', () => {
    const result = spawnSync(bun!, [probe], { encoding: 'utf8', timeout: 60_000 });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout.trim()) as { ok: boolean; runtime: string; encryptions: number };
    expect(report).toMatchObject({ ok: true, encryptions: 6 });
    expect(report.runtime).toMatch(/^bun \d+\.\d+\.\d+/u);
  });
});
