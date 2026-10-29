import assert from 'node:assert/strict';
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
