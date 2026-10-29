import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
test('SEA native, SQLite and gate commands each run exactly once under their original conditions', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8');
  for (const [command, condition] of [
    ['node examples/packaging/native-assets-smoke.mjs --copy-only', "matrix.recipe == 'sea' && matrix.os == 'macos-latest'"],
    ['node examples/packaging/native-assets-smoke.mjs', "matrix.recipe == 'sea' && matrix.os == 'windows-latest'"],
    ['node examples/packaging/sqlite-smoke.mjs --sea', "matrix.recipe == 'sea'"],
    ['node examples/packaging/gate-smoke.mjs --sea', "matrix.recipe == 'sea'"],
  ]) {
    const lines = workflow.split('\n');
    const indexes = lines.flatMap((line, index) => line.trim() === `run: ${command}` ? [index] : []);
    assert.equal(indexes.length, 1, command);
    assert.equal(lines[indexes[0] - 1].trim(), `if: ${condition}`);
  }
});
