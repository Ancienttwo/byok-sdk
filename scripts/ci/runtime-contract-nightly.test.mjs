import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { RUNTIMES } from './runtime-contract-install.mjs';

/**
 * #1103: the nightly runtime contract workflow's selection contract. The
 * workflow's value is that a latest-CLI regression becomes visible, so a
 * change that drops a runtime, flips the mode, tolerates a failing leg, or
 * removes the retained evidence must fail here before it ships. The forced
 * detector break itself is exercised without a CLI by
 * packages/client/src/__tests__/runtime-contract-harness.test.ts.
 */

const workflow = readFileSync(new URL('../../.github/workflows/runtime-contract-nightly.yml', import.meta.url), 'utf8');
const contractDirectory = new URL('../../packages/client/src/__tests__/runtime-contract/', import.meta.url);
const contractFile = (runtime) => readFileSync(new URL(`${runtime}.contract.ts`, contractDirectory), 'utf8');

/** One job block: from its 2-space header to the next 2-space job header. */
function job(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `workflow job ${name} exists`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n  [a-z0-9-]+:\n/u);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

const latest = job('latest');
const report = job('report');
const matrix = /matrix:\n\s+runtime: \[([^\]]+)\]/u.exec(latest);

test('the nightly run is schedule + manual dispatch only and never gates a PR', () => {
  const on = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\nconcurrency:'));
  assert.match(on, /schedule:/u);
  assert.match(on, /cron: '17 9 \* \* \*'/u);
  assert.match(on, /workflow_dispatch:/u);
  assert.doesNotMatch(on, /pull_request|push:/u);
});

test('selects exactly the five contract runtimes in latest mode', () => {
  assert.ok(matrix, 'the latest job has a runtime matrix');
  const selected = matrix[1].split(',').map((name) => name.trim());
  assert.deepEqual([...selected].sort(), [...RUNTIMES].sort(), 'every contract runtime runs; no runtime is dropped or invented');
  assert.match(latest, /env:\n      BYOK_RUNTIME_CONTRACT: latest\n/u);
  assert.equal((latest.match(/BYOK_RUNTIME_CONTRACT:/gu) ?? []).length, 1, 'one mode for the whole job');

  // The installer resolves the newest release of the selected runtime; the
  // suite runs the matching file. Neither command is a qualified-version
  // fallback, and both interpolate the matrix entry rather than hardcoding a
  // subset.
  assert.ok(latest.includes('node scripts/ci/runtime-contract-install.mjs'), 'installer command');
  assert.ok(latest.includes('${{ matrix.runtime }} latest'), 'installs the latest release of the selected runtime');
  assert.ok(latest.includes('"$SUITE/${{ matrix.runtime }}.contract.ts"'), 'runs the selected runtime contract file');
  for (const runtime of RUNTIMES) {
    assert.ok(existsSync(new URL(`${runtime}.contract.ts`, contractDirectory)), `${runtime}.contract.ts exists`);
  }
});

test('fails closed: no leg tolerates a failing install or suite', () => {
  assert.doesNotMatch(latest, /continue-on-error|passWithNoTests|\|\|\s*true\b|set \+e/u);
  assert.doesNotMatch(latest, /--exclude|BYOK_CONTRACT_SKIP/u);
  // The only conditional step is the always-run evidence upload; an install or
  // suite step that could be skipped would report a false pass.
  const conditionals = latest.match(/^\s+if: /gmu) ?? [];
  assert.equal(conditionals.length, 1, 'only the evidence upload is conditional');
  assert.match(latest, /^        if: \$\{\{ always\(\) \}\}$/mu);
});

test('retains per-leg evidence on success and failure', () => {
  assert.match(latest, /set -o pipefail/u);
  assert.match(latest, /tee -a "\$log"/u);
  assert.ok(latest.includes('runtime-contract-${{ matrix.runtime }}.log'), 'evidence log path');
  assert.ok(latest.includes('name: runtime-contract-${{ matrix.runtime }}-latest'), 'artifact name');
  assert.ok(latest.includes('path: ${{ runner.temp }}/runtime-contract-${{ matrix.runtime }}.log'), 'artifact path');
  assert.match(latest, /actions\/upload-artifact@[0-9a-f]{40} # v4\.6\.2/u);
  assert.match(latest, /if-no-files-found: error/u);
  assert.match(latest, /retention-days: 7/u);
});

test('every whole-runtime skip is explicit and names the bundled Pi pin', () => {
  const skippers = RUNTIMES.filter((runtime) => contractFile(runtime).includes('skipRuntimeContract('));
  assert.deepEqual(skippers, ['pi'], 'only the bundled runtime may skip the latest run');
  assert.match(contractFile('pi'), /skipRuntimeContract\([\s\S]*?byok\.piRuntimePin/u);
  for (const runtime of RUNTIMES) {
    assert.match(contractFile(runtime), /defineRuntimeContract\(/u, `${runtime} registers the contract cases`);
    assert.doesNotMatch(contractFile(runtime), /\b(?:describe|it)\.skip\(/u, `${runtime} skips through the reasoned plan, not directly`);
  }
});

test('reports a failure to one tracking issue with the retained evidence link', () => {
  assert.match(report, /needs: latest/u);
  assert.match(report, /needs\.latest\.result == 'failure'/u);
  assert.match(report, /issues: write/u);
  assert.match(report, /gh issue create --title "\$TITLE" --body "\$body"/u);
  assert.match(report, /gh issue comment "\$number" --body "\$body"/u);
  assert.ok(report.includes('#artifacts'), 'links the retained evidence');
  assert.ok(report.includes('runtime-contract-<runtime>-latest'));
  assert.ok(report.includes('Refs #1103'));
});
