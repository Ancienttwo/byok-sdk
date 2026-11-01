import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

test('reports only after a failed latest leg, with issue write access', () => {
  assert.match(report, /needs: latest/u);
  assert.match(report, /needs\.latest\.result == 'failure'/u);
  assert.match(report, /issues: write/u);
});

/** The report step's bash script and its literal TITLE, as GitHub runs them. */
function reportStep() {
  const lines = report.split('\n');
  const runAt = lines.findIndex((line) => line === '        run: |');
  assert.notEqual(runAt, -1, 'the report step has a run block');
  const script = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line.length > 0 && !line.startsWith('          ')) break;
    script.push(line.slice(10));
  }
  const title = /^ {10}TITLE: '([^']+)'$/mu.exec(report);
  assert.ok(title, 'the report step sets a literal TITLE');
  return { script: script.join('\n'), title: title[1] };
}

/**
 * Runs the step under GitHub's bash flags with a stub gh that records each
 * call's argv; no request reaches GitHub.
 */
function runReport(existingIssue) {
  const { script, title } = reportStep();
  const dir = mkdtempSync(join(tmpdir(), 'byok-nightly-report-'));
  try {
    const calls = join(dir, 'calls');
    mkdirSync(calls);
    writeFileSync(join(dir, 'gh'), [
      '#!/usr/bin/env bash',
      'set -eu',
      'n=$(ls "$STUB_CALLS" | wc -l | tr -d " ")',
      'printf "%s\\0" "$@" > "$STUB_CALLS/$(printf %03d "$n")"',
      'case "$1 $2" in',
      '  "run view") echo "latest (codex), latest (pi)" ;;',
      '  "issue list") printf "%s\\n" "$STUB_ISSUE" ;;',
      'esac',
      '',
    ].join('\n'));
    chmodSync(join(dir, 'gh'), 0o755);
    writeFileSync(join(dir, 'step.sh'), script);
    const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', join(dir, 'step.sh')], {
      encoding: 'utf8',
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        STUB_CALLS: calls,
        STUB_ISSUE: existingIssue ?? '',
        GITHUB_RUN_ID: '4242',
        GITHUB_SHA: 'abc123def',
        RUN_URL: 'https://github.com/o/r/actions/runs/4242',
        TITLE: title,
      },
    });
    const argv = readdirSync(calls).sort().map((name) => readFileSync(join(calls, name), 'utf8').split('\0').slice(0, -1));
    return { result, argv, title };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const expectedBody = [
  'The runtime contract suite failed against the latest CLI.',
  '',
  '- Run: https://github.com/o/r/actions/runs/4242',
  '- Failed legs: latest (codex), latest (pi)',
  '- Commit: abc123def',
  '- Retained evidence: https://github.com/o/r/actions/runs/4242#artifacts',
  '  (`runtime-contract-<runtime>-latest`, 7 days)',
  '',
  'See docs/runtime-contract.md. Refs #1103.',
].join('\n');

test('comments on the open tracking issue with literal Markdown backticks', () => {
  const { result, argv } = runReport('17');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(argv.map((call) => call.slice(0, 2).join(' ')), ['run view', 'issue list', 'issue comment']);
  assert.deepEqual(argv[2], ['issue', 'comment', '17', '--body', expectedBody]);
});

test('creates the tracking issue when none is open', () => {
  const { result, argv, title } = runReport(undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(argv.map((call) => call.slice(0, 2).join(' ')), ['run view', 'issue list', 'issue create']);
  assert.deepEqual(argv[2], ['issue', 'create', '--title', title, '--body', expectedBody]);
});
