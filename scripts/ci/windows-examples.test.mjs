import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { selectImpact } from './select-impact.mjs';
import { windowsBotArgs } from './run-windows-bot-tests.mjs';

// #738: the persona consumer writes with the SDK writeHomeFile, so the suites
// that use the real persona fixture run on Windows too. Nothing is excluded.
test('the K8 Windows runner runs every suite, with the real persona fixture suites', () => {
  const root = new URL('../../examples/bot-collaboration/src/', import.meta.url);
  const persona = readdirSync(root).filter(name => name.endsWith('.test.ts')
    && readFileSync(new URL(name, root), 'utf8').includes("from './team.test-support'"));
  assert.ok(persona.length > 0);
  assert.deepEqual(windowsBotArgs(), ['run', '--cwd', 'examples/bot-collaboration', 'test']);
});

test('K4, K8 and Windows runner changes require the Windows-containing family', () => {
  for (const path of ['packages/server/src/execution-core/core.ts', 'examples/host-execution-core/src/core.test.ts', 'examples/bot-collaboration/src/channel.ts', 'scripts/ci/run-windows-bot-tests.mjs']) {
    assert.ok(selectImpact([path]).families.includes('adapter-lifecycle-smoke'));
  }
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const job = workflow.split('  adapter-lifecycle-smoke:')[1].split('\n  dataplane:')[0];
  assert.match(job, /os: \[ubuntu-latest, macos-latest, windows-latest\]/);
  assert.match(job, /name: K4 Windows Host execution qualification\n        if: matrix.os == 'windows-latest'\n        run: bun run --cwd examples\/host-execution-core test\n/);
  assert.match(job, /name: K8 Windows portable Bot qualification\n        if: matrix.os == 'windows-latest'\n        run: node scripts\/ci\/run-windows-bot-tests.mjs/);
});

test('Windows Host steps keep their SQLite temp roots on the runner local disk', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const job = workflow.split('  adapter-lifecycle-smoke:')[1].split('\n  dataplane:')[0];
  for (const name of ['K4 Windows Host execution qualification', 'K8 Windows portable Bot qualification']) {
    const step = job.split(`      - name: ${name}\n`)[1].split('\n      - name:')[0].split('\n      #')[0];
    assert.match(step, /\n        env:\n          TEMP: \$\{\{ runner\.temp \}\}\n          TMP: \$\{\{ runner\.temp \}\}(\n|$)/, name);
  }
});
