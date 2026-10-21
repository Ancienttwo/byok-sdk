import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { selectImpact } from './select-impact.mjs';

const plan = JSON.parse(process.env.CI_PLAN ?? '');
if (plan.mode !== 'targeted') throw new Error('Targeted runner refuses a release or missing plan');
const verified = selectImpact(plan.files);
if (JSON.stringify(verified.dirs) !== JSON.stringify(plan.dirs) || JSON.stringify(verified.families) !== JSON.stringify(plan.families)) {
  throw new Error('Impact plan does not match changed paths');
}
for (const dir of plan.dirs) {
  const manifest = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'));
  for (const script of ['typecheck', 'test']) {
    if (!manifest.scripts?.[script]) {
      if (dir === 'examples/packaging' && script === 'test' && plan.families.includes('packageability-smoke')) continue;
      throw new Error(`Selected workspace ${dir} has no ${script} check; explicit release validation required`);
    }
    const result = spawnSync('bun', ['run', '--cwd', dir, script], { stdio: 'inherit', env: process.env });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
