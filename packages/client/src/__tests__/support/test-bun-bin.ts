import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The bun test gate — the client-side twin of the dataplane gate
 * (packages/cloud-dataplane/src/__tests__/support/dataplane.ts), and the only
 * place the bun-dependent suites' interpreter lookup is written down.
 *
 * Three behaviors, and each later one keeps the earlier ones honest:
 *
 * - No candidate exists → `resolveBunBin` returns undefined and the suites
 *   `it.skipIf` themselves, so a developer without bun sees a visible skip,
 *   not a body that returns early and reports as a pass.
 * - `BYOK_REQUIRE_BUN=1` → absence is a hard failure thrown from the
 *   importing suite's module scope instead. That flag is set by exactly one
 *   CI job (build-test, which also resolves the real bun path into
 *   `BYOK_TEST_BUN_BIN`), so the skip path can never be how that job stays
 *   green.
 * - `BYOK_REQUIRE_BUN=1` with `BYOK_TEST_BUN_BIN` set is strict: the named
 *   path is the entire candidate set. Missing or not a file → a throw naming
 *   that exact path. The helper must never scan on from a bad explicit path
 *   and silently run a substitute bun underneath the formal gate.
 *
 * The candidate list is the exact union of the lists the three suites carried
 * before this helper existed — pi-s2-bundle-resolution, pi-mcp-launch-cwd and
 * pi-runtime-launch-cwd all probed the same four candidates in this order. It
 * deliberately does NOT include `~/.bun/bin/bun`: that is setup-bun's
 * internal install default, not a location a developer is assumed to have,
 * and the CI formal gate names the real path explicitly through
 * `BYOK_TEST_BUN_BIN` instead of relying on a guess.
 */

export const TEST_BUN_BIN_ENV = 'BYOK_TEST_BUN_BIN';
export const REQUIRE_BUN_ENV = 'BYOK_REQUIRE_BUN';

/**
 * The unified candidate list, highest priority first. `env` and `homedir` are
 * parameters rather than ambient reads so the pin test can prove the
 * fail-closed semantics deterministically on machines that do have bun.
 */
export function bunBinCandidates(env: NodeJS.ProcessEnv, homedir: string): Array<string | undefined> {
  return [
    env[TEST_BUN_BIN_ENV],
    path.join(homedir, '.local/bin/bun'),
    '/opt/homebrew/bin/bun',
    '/usr/local/bin/bun',
  ];
}

/**
 * The single existence probe: a candidate counts only when it resolves to an
 * existing file. Neither a missing path nor a directory named bun is a
 * runnable interpreter. Kept as one boolean seam so the pin tests stay
 * deterministic while production defaults still reject both shapes.
 */
function existsAsFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

export function resolveBunBin(
  env: NodeJS.ProcessEnv = process.env,
  homedir: string = os.homedir(),
  exists: (candidate: string) => boolean = existsAsFile,
): string | undefined {
  const explicit = env[TEST_BUN_BIN_ENV];
  if (env[REQUIRE_BUN_ENV] === '1' && explicit !== undefined) {
    // Strict mode. The formal gate names its interpreter through
    // BYOK_TEST_BUN_BIN, and under REQUIRE that name is the whole candidate
    // set. Falling through to the scan here would let a bad explicit path
    // plus an installed default silently run the substitute bun and keep the
    // job green — the exact substitution this branch makes impossible.
    if (!exists(explicit)) {
      throw new Error(
        `${REQUIRE_BUN_ENV}=1 and ${TEST_BUN_BIN_ENV}=${explicit}, but that path is missing or not a file. ` +
        'The build-test job runs exactly the interpreter it resolved — no fallback candidate is substituted.',
      );
    }
    return explicit;
  }
  const candidates = bunBinCandidates(env, homedir);
  const found = candidates.find((candidate): candidate is string => candidate !== undefined && exists(candidate));
  if (found === undefined && env[REQUIRE_BUN_ENV] === '1') {
    // Thrown from the importing suite's module scope on purpose: a suite that
    // skipped here would report a pass, and the one job that sets this flag
    // exists to make that impossible.
    const searched = candidates.map((candidate) => candidate === undefined ? `${TEST_BUN_BIN_ENV} (unset)` : candidate).join(', ');
    throw new Error(
      `${REQUIRE_BUN_ENV}=1 but no bun interpreter exists (searched: ${searched}). ` +
      'The build-test job must run the bun-dependent suites for real — a skip is not a success conclusion there.',
    );
  }
  return found;
}
