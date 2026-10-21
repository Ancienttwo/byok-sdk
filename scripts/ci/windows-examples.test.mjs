import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';
import { selectImpact } from './select-impact.mjs';
import { windowsPersonaSuites, windowsBotArgs } from './run-windows-bot-tests.mjs';

test('Windows exclusions match only suites using the real POSIX persona fixture', () => {
  const root = new URL('../../examples/bot-collaboration/src/', import.meta.url);
  const persona = readdirSync(root).filter(name => name.endsWith('.test.ts')
    && readFileSync(new URL(name, root), 'utf8').includes("from './team.test-support'"));
  assert.deepEqual([...windowsPersonaSuites].sort(), persona.map(name => `src/${name}`).sort());
  assert.equal(new Set(windowsPersonaSuites).size, windowsPersonaSuites.length);
  assert.ok(readdirSync(root).filter(name => name.endsWith('.test.ts')).length > persona.length);
  assert.deepEqual(windowsBotArgs(), ['run', '--cwd', 'examples/bot-collaboration', 'test', '--',
    ...windowsPersonaSuites.flatMap(path => ['--exclude', path])]);
});

test('K4, K8 and Windows runner changes require the Windows-containing family', () => {
  for (const path of ['examples/host-execution-core/src/core.ts', 'examples/bot-collaboration/src/channel.ts', 'scripts/ci/run-windows-bot-tests.mjs']) {
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
