import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { verifyPrPlan } from './plan-ci.mjs';
import { reviewedScripts, selectImpact } from './select-impact.mjs';

const plan = JSON.parse(process.env.CI_PLAN ?? '');
if (plan.mode !== 'targeted') throw new Error('Targeted runner refuses a release or missing plan');
const base = verifyPrPlan(plan);
if (plan.base !== base) throw new Error('CI comparison base mismatch');
const verified = selectImpact(plan.files, { base });
if (JSON.stringify(verified.dirs) !== JSON.stringify(plan.dirs) || JSON.stringify(verified.families) !== JSON.stringify(plan.families)) {
  throw new Error('Impact plan does not match changed paths');
}
const extraTests = [];
if (plan.files.includes('scripts/release/agent-memory-helper-source.test.mjs')) extraTests.push('scripts/release/agent-memory-helper-source.test.mjs');
if (plan.files.some(path => /^scripts\/release\/registry-/.test(path))) extraTests.push('scripts/release/registry-contract.test.mjs', 'scripts/release/registry-npm.test.mjs');
if (plan.files.some(path => path.startsWith('packages/client/vendor/oar/')
  || /^scripts\/api-surface\/(?:check-oar-bridge\.test\.mjs|oar-bridge-types\.ts|tsconfig\.oar-bridge\.json)$/.test(path))) extraTests.push('scripts/api-surface/check-oar-bridge.test.mjs');
if (plan.files.some(path => path === 'scripts/vitest/tmp-root.mjs' || path === 'scripts/vitest/tmp-root.test.mjs')) extraTests.push('scripts/vitest/tmp-root.test.mjs');
for (const path of plan.files) if (Object.hasOwn(reviewedScripts, path)) extraTests.push(...reviewedScripts[path].tests);
if (extraTests.length) {
  const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...new Set(extraTests)], { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
for (const dir of plan.dirs) {
  const manifest = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
  for (const script of ['typecheck', 'test']) {
    if (!manifest.scripts?.[script]) {
      // examples/packaging has no unit suite. Its runtime test is the
      // packageability-smoke family, which runs for its owned paths and in
      // release validation. A dependent-only selection runs its typecheck.
      if (dir === 'examples/packaging' && script === 'test') continue;
      throw new Error(`Selected workspace ${dir} has no ${script} check; add a reviewed workspace check`);
    }
    const result = spawnSync('bun', ['run', '--cwd', dir, script], { stdio: 'inherit', env: process.env });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
