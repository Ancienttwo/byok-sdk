import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
const refs = {
  baseline: '1e5326eb38a3476d1a69733a43a5adb3526eba45',
  candidate: '68cc0659c6c04d640347188e72a5fbda0bea7ad3',
};
const args = process.argv.slice(2);
const check = args[0] === '--check';
if (check) args.shift();
if (args.length !== 2) throw new Error('Usage: admission-639.mjs [--check] BASELINE_DIR CANDIDATE_DIR');
const helper = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'failure-diagnostics.ts'), 'utf8');
const importLine = "import { hostFailureSnapshot, withFailureSnapshot } from './failure-diagnostics';\n";
const cases = [
  { file: 'core.test.ts', name: 'retries a retryable device failure only with an explicit source policy', key: "'retry-failure'",
    expression: "vi.waitFor(() => expect(host.core.intent('retry-failure')?.generation).toBe(1), { timeout: 5000 })" },
  { file: 'retention.test.ts', name: 'does not recreate a completed routine or reapply its SDK terminal on replay before or after expiry', key: 'intent.key',
    expression: 'vi.waitFor(() => expect(host.adapter.sessions.has(intent.taskId)).toBe(true))' },
];
const normalize = text => text.replace(/\r\n/g, '\n');
const git = (cwd, ...argv) => execFileSync('git', argv, { cwd, encoding: 'utf8' }).trim();
const once = (source, anchor) => { if (source.split(anchor).length !== 2) throw new Error('Expected exactly one diagnostic anchor'); };
function overlay(raw, item, label) {
  const before = normalize(raw);
  const plain = `await ${item.expression};`;
  const wrapped = `await withFailureSnapshot(${item.expression}, () => hostFailureSnapshot(host, ${item.key}));`;
  let after = before;
  if (label === 'baseline') {
    once(before, plain);
    if (before.includes(importLine.trim()) || before.includes(wrapped)) throw new Error('Baseline already instrumented');
    after = importLine + before.replace(plain, wrapped);
    // Exact inverse proves no assertion expression, timeout, interval or unrelated source changed.
    if (after.slice(importLine.length).replace(wrapped, plain) !== before) throw new Error('Unexpected baseline source edit');
  } else {
    once(before, wrapped); once(before, importLine.trim());
  }
  const tokens = source => [...source.matchAll(/timeout:\s*\d+|interval:\s*\d+|expect\(/g)].map(match => match[0]);
  if (JSON.stringify(tokens(before)) !== JSON.stringify(tokens(after))) throw new Error('Assertion/deadline tokens changed');
  return after;
}
// Validate BOTH exact checkouts before writing either or running any setup/test.
const plans = Object.entries(refs).map(([label, sha], index) => {
  const cwd = resolve(args[index]);
  if (git(cwd, 'rev-parse', 'HEAD') !== sha) throw new Error(`${label}: wrong HEAD`);
  const files = cases.map(item => {
    const relative = `examples/host-execution-core/src/${item.file}`;
    const raw = readFileSync(resolve(cwd, relative), 'utf8');
    const pinned = execFileSync('git', ['show', `${sha}:${relative}`], { cwd, encoding: 'utf8' });
    if (normalize(raw) !== normalize(pinned)) throw new Error(`${label}: source differs from pinned ref`);
    const after = overlay(raw, item, label);
    if (overlay(normalize(raw).replace(/\n/g, '\r\n'), item, label) !== after) throw new Error('CRLF validation differs');
    return { relative, after };
  });
  console.log(`BYOK_DIAGNOSTIC_CHECK ${label} ${sha} exact anchors, assertions, deadlines and CRLF preserved`);
  return { label, sha, cwd, files };
});
console.log(`BYOK_DIAGNOSTIC_HELPER_SHA256 ${createHash('sha256').update(helper).digest('hex')}`);
if (!check) {
  let failed = false;
  for (const { label, sha, cwd, files } of plans) {
    for (const { relative, after } of files) writeFileSync(resolve(cwd, relative), after);
    writeFileSync(resolve(cwd, 'examples/host-execution-core/src/failure-diagnostics.ts'), helper);
    console.log(`BYOK_DIAGNOSTIC_SOURCE ${label} ${sha}`);
    let setup = true;
    for (const argv of [['ci'], ['run', '--filter', './packages/*', '--if-present', 'build']]) {
      const result = spawnSync('bun', argv, { cwd, stdio: 'inherit' });
      console.log(`BYOK_DIAGNOSTIC_SETUP_EXIT ${label} ${argv[0]} ${result.status ?? 1}`);
      if (result.error || result.status !== 0) { failed = true; setup = false; break; }
    }
    if (!setup) { console.log(`BYOK_DIAGNOSTIC_TESTS_NOT_RUN ${label} setup-failed`); continue; }
    // Separate processes enforce core then retention; retain each checkout's original Vitest config/globalSetup.
    for (const item of cases) {
      if (!/^[A-Za-z ]+$/.test(item.name)) throw new Error('Unexpected test-name regex syntax');
      const pattern = '^' + item.name + '$';
      const result = spawnSync('bun', ['run', '--cwd', 'examples/host-execution-core', 'test', `src/${item.file}`, '-t', pattern], { cwd, stdio: 'inherit' });
      console.log(`BYOK_DIAGNOSTIC_TEST_EXIT ${label} ${item.file} ${result.status ?? 1}`);
      if (result.error || result.status !== 0) failed = true;
    }
  }
  if (failed) process.exitCode = 1;
}
