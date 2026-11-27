import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'bun:test';

const soak = fileURLToPath(new URL('./client-retention-soak.mjs', import.meta.url));

test('the first soak task starts with the result helper and completes with a report', () => {
  const directory = mkdtempSync(join(tmpdir(), 'byok-soak-smoke-'));
  try {
    const output = join(directory, 'report.json');
    const summary = join(directory, 'summary.md');
    const run = Bun.spawnSync(
      [process.execPath, soak, '--tasks', '1', '--out', output, '--summary', summary],
      { timeout: 15_000 },
    );
    assert.equal(run.exitCode, 0, run.stderr.toString() + run.stdout.toString());

    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(report.schema, 'byok.client-retention-soak.v1');
    assert.equal(report.passed, true);
    assert.deepEqual(report.outcomes, { complete: 1, failed: 0, unexpected: 0 });
    assert.equal(report.final.tasksCompleted, 1);
    assert.match(readFileSync(summary, 'utf8'), /- Result: PASS/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
