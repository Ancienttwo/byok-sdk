import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { knownFamilies, selectImpact } from './select-impact.mjs';

export function planCi({ event, sha, approvedSha, paths }) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('CI requires an exact commit SHA');
  if (event === 'workflow_dispatch') {
    if (approvedSha !== sha) throw new Error('Release validation SHA differs from the dispatched commit');
    return { mode: 'release', sha, dirs: [], files: [], families: [...knownFamilies] };
  }
  if (!['pull_request', 'push'].includes(event)) throw new Error('Unsupported CI event');
  return { ...selectImpact(paths), mode: 'targeted', sha };
}

export function changedPaths(base, cwd = process.cwd()) {
  if (!/^[a-f0-9]{40}$/.test(base ?? '') || /^0+$/.test(base)) throw new Error('Missing comparison base: explicit release validation required');
  return execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', base, 'HEAD'], { cwd, encoding: 'utf8' }).split('\0').filter(Boolean);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = process.env.CI_EVENT;
  let paths;
  if (event !== 'workflow_dispatch') {
    paths = changedPaths(process.env.CI_BASE);
  }
  const plan = planCi({ event, sha: process.env.GITHUB_SHA, approvedSha: process.env.CI_RELEASE_SHA, paths });
  console.log(JSON.stringify(plan, null, 2));
  appendFileSync(process.env.GITHUB_OUTPUT, `plan=${JSON.stringify(plan)}\nfamilies=${JSON.stringify(plan.families)}\nrelease=${plan.mode === 'release'}\nbuild=${plan.dirs.length > 0}\n`);
}
