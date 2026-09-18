import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REQUIRE_BUN_ENV, TEST_BUN_BIN_ENV, bunBinCandidates, resolveBunBin } from './test-bun-bin';

const CI_WORKFLOW = readFileSync(new URL('../../../../../.github/workflows/ci.yml', import.meta.url), 'utf8');

/** Never true: the deterministic "no bun anywhere" input for the pins below. */
const nothingExists = (): boolean => false;

describe('the bun test gate', () => {
  it('probes exactly the unified candidate list, in priority order', () => {
    // The union of the three suites' pre-helper lists. A candidate dropped
    // here is a local discovery path that silently regressed; one added here
    // would re-widen the search without the union having been re-decided.
    const probed: Array<string | undefined> = [];
    resolveBunBin({ [TEST_BUN_BIN_ENV]: '/env/bun' }, '/home/u', (candidate) => {
      probed.push(candidate);
      return false;
    });
    expect(probed).toEqual(bunBinCandidates({ [TEST_BUN_BIN_ENV]: '/env/bun' }, '/home/u'));
    expect(probed).toEqual(['/env/bun', '/home/u/.local/bin/bun', '/opt/homebrew/bin/bun', '/usr/local/bin/bun']);
  });

  it(`throws when ${REQUIRE_BUN_ENV}=1 and no candidate exists (fail-closed, never skip)`, () => {
    expect(() =>
      resolveBunBin({ [TEST_BUN_BIN_ENV]: '/nonexistent/bun', [REQUIRE_BUN_ENV]: '1' }, '/home/empty', nothingExists),
    ).toThrow(new RegExp(REQUIRE_BUN_ENV));
  });

  it('returns undefined without the flag, so the suites keep their skip path', () => {
    expect(resolveBunBin({ [TEST_BUN_BIN_ENV]: '/nonexistent/bun' }, '/home/empty', nothingExists)).toBeUndefined();
  });

  it(`lets ${TEST_BUN_BIN_ENV} win even when a fallback candidate also exists`, () => {
    // CI names the real interpreter through this env var; a discovered
    // fallback must never outrank it.
    const envThenFallback = (candidate: string): boolean => candidate === '/env/bun' || candidate === '/opt/homebrew/bin/bun';
    expect(resolveBunBin({ [TEST_BUN_BIN_ENV]: '/env/bun' }, '/home/u', envThenFallback)).toBe('/env/bun');
  });

  it('is wired into the CI build-test job as the formal gate', () => {
    // The whole point of the flag: with it set on build-test, a lost bun or a
    // wrong path is a hard failure rather than three silent skips. Delete the
    // job env or the resolution step and the bun suites go back to skipping
    // everywhere and nothing else notices — so the wiring is pinned here, the
    // same way the dataplane job is pinned by its constraints test.
    expect(CI_WORKFLOW).toMatch(/^ {2}build-test:$/m);
    expect(CI_WORKFLOW).toContain(`BYOK_REQUIRE_BUN: '1'`);
    expect(CI_WORKFLOW).toContain('command -v bun');
    expect(CI_WORKFLOW).toContain('BYOK_TEST_BUN_BIN');
    expect(CI_WORKFLOW).toContain('>> "$GITHUB_ENV"');
  });
});
