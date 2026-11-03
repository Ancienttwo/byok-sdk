import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

test('every permanent server skip names a tracked decision', () => {
  const root = fileURLToPath(new URL('../../packages/server/src/', import.meta.url));
  const files = readdirSync(root, { recursive: true }).filter(file => file.endsWith('.test.ts'));
  assert.ok(files.length > 0);
  for (const file of files) {
    const lines = readFileSync(join(root, file), 'utf8').split('\n');
    for (const [index, line] of lines.entries()) {
      if (!/\b(?:it|test|describe)\.(?:skip|todo)\(/.test(line)) continue;
      assert.match(lines[index - 1] ?? '', /\/\/ Decision D\d+: https:\/\/github\.com\/Ancienttwo\/byok-sdk\/issues\/\d+$/,
        `${file}:${index + 1}: permanent skips require a tracked decision immediately above the test`);
    }
  }
});

test('tracked scripts detect the CLI entry with import.meta.main, not a hand-written argv guard', () => {
  // Comparing argv[1] with import.meta.url fails when the script starts through
  // a symlinked path (macOS /tmp), so the script silently exits 0 without running.
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const files = execFileSync('git', ['ls-files', '-z', '--', 'scripts', 'examples', ':(glob)packages/*/scripts/**', ':(glob)packages/*/src/**'], { cwd: repo, encoding: 'utf8' })
    .split('\0').filter(file => /\.(?:[cm]?js|[cm]?ts)$/.test(file) && !file.endsWith('.d.ts'));
  assert.ok(files.length > 0);
  const argvEntry = /process\.argv(?:\[1\]|\.at\(1\))/;
  const violations = [];
  for (const file of files) {
    const lines = readFileSync(join(repo, file), 'utf8').split('\n');
    // A guard may wrap onto the next line.
    for (const [index, line] of lines.entries()) {
      if (!argvEntry.test(line) || violations.at(-1) === `${file}:${index}`) continue;
      if (`${line}\n${lines[index + 1] ?? ''}`.includes('import.meta.url')) violations.push(`${file}:${index + 1}`);
    }
  }
  assert.deepEqual(violations, [], `use \`if (import.meta.main)\` instead of comparing argv with import.meta.url:\n${violations.join('\n')}`);
});
