/**
 * Runs the member rule vectors under Bun (#654 E2b). The device daemon is a
 * Bun-compiled binary, so Node-only evidence would not cover the runtime that
 * computes member fingerprints, pairing MACs and chain checks.
 *
 * The interpreter lookup is a copy of `hpke-bun.test.ts`: no candidate → a
 * visible skip; `BYOK_REQUIRE_BUN=1` (set by the CI targeted job, which also
 * names the interpreter through `BYOK_TEST_BUN_BIN`) → absence is a hard
 * failure, never a skip.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { checkMemberRulesVectors, type MemberRulesCheckCounts, type MemberRulesVectors } from './support/member-rules-vectors';

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
  const found = [explicit, path.join(os.homedir(), '.local/bin/bun'), path.join(os.homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun'].find(isFile);
  if (found === undefined && process.env.BYOK_REQUIRE_BUN === '1') {
    throw new Error('BYOK_REQUIRE_BUN=1 but no bun interpreter was found');
  }
  return found;
}

const bun = resolveBun();
const probe = fileURLToPath(new URL('./support/member-rules-bun-probe.ts', import.meta.url));
const golden = JSON.parse(readFileSync(new URL('./golden/member-rules-v1.json', import.meta.url), 'utf8')) as MemberRulesVectors;

describe('member rule vectors under Bun', () => {
  it.skipIf(bun === undefined)('run every check that the Node leg runs', async () => {
    const result = spawnSync(bun!, [probe], { encoding: 'utf8', timeout: 60_000 });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout.trim()) as { ok: boolean; runtime: string; counts: MemberRulesCheckCounts };
    expect(report.ok).toBe(true);
    expect(report.runtime).toMatch(/^bun \d+\.\d+\.\d+/u);
    expect(report.counts).toEqual(await checkMemberRulesVectors(golden));
  });
});
