import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { knownFamilies, scriptChecksForPaths, selectImpact } from './select-impact.mjs';
import { LOCKFILE_VERSION_REASON } from './dependency-impact.mjs';

// Release validation remains exact-SHA dispatch only; full test coverage also
// runs nightly or for a verified lockfile format transition.
export const isReleaseRef = ref => ref === 'refs/heads/main' || /^refs\/heads\/release\/[A-Za-z0-9._-]+$/.test(ref ?? '');

export function planCi({ event, sha, approvedSha, ref, paths, base, cwd }) {
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('CI requires an exact commit SHA');
  if (event === 'schedule') {
    if (ref !== 'refs/heads/main') throw new Error('Nightly validation runs only on main');
    return { mode: 'nightly', sha, dirs: [], files: [], families: [...knownFamilies] };
  }
  if (event === 'workflow_dispatch') {
    if (!isReleaseRef(ref)) throw new Error(`Release validation runs only on main or release/* refs, not ${JSON.stringify(ref)}`);
    if (approvedSha !== sha) throw new Error('Release validation SHA differs from the dispatched commit');
    return { mode: 'release', sha, dirs: [], files: [], families: [...knownFamilies] };
  }
  if (!['pull_request', 'push'].includes(event)) throw new Error('Unsupported CI event');
  const plan = { ...selectImpact(paths, { base, cwd }), base, mode: 'targeted', sha };
  assertTargetedScope(plan);
  return plan;
}

// Called on selector output, never on a PR-provided scope/reason flag.
export function assertTargetedScope(plan) {
  if (plan.families.some(id => id === 'build-test' || id === 'macos-client')
    && plan.reason !== LOCKFILE_VERSION_REASON) {
    throw new Error('Only a verified lockfileVersion transition may select a targeted full matrix');
  }
}

// The targeted job installs and builds for a selected workspace, a manifest or
// lock change, or a reviewed script whose tests need installed packages.
export const needsBuild = plan => plan.dirs.length > 0 || scriptChecksForPaths(plan.files).install
  || plan.files.some(path => path === 'bun.lock' || /^packages\/[^/]+\/package\.json$/.test(path));

export function changedPaths(base, cwd = process.cwd()) {
  if (!/^[a-f0-9]{40}$/.test(base ?? '') || /^0+$/.test(base)) throw new Error('Missing comparison base: explicit release validation required');
  return execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', base, 'HEAD'], { cwd, encoding: 'utf8' }).split('\0').filter(Boolean);
}

// GitHub's event base can lag the main parent of the tested synthetic merge.
// Resolve the comparison from that exact merge, never from a moving branch ref.
export function resolveCiBase(env = process.env, cwd = process.cwd()) {
  if (env.CI_EVENT !== 'pull_request') return env.CI_BASE;
  const exact = value => /^[a-f0-9]{40}$/.test(value ?? '') && !/^0+$/.test(value);
  if (![env.GITHUB_SHA, env.CI_PR_HEAD, env.CI_BASE].every(exact)) throw new Error('Missing exact PR comparison evidence');
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (git('rev-parse', 'HEAD') !== env.GITHUB_SHA) throw new Error('PR checkout does not match tested SHA');
  const parents = git('show', '-s', '--format=%P', env.GITHUB_SHA).split(' ');
  if (parents.length !== 2 || parents[1] !== env.CI_PR_HEAD) throw new Error('PR merge parents do not match event head');
  git('merge-base', '--is-ancestor', env.CI_BASE, parents[0]);
  return parents[0];
}

export function verifyPrPlan(plan, env = process.env, cwd = process.cwd()) {
  const base = resolveCiBase(env, cwd);
  if (env.CI_EVENT === 'pull_request' && (plan.sha !== env.GITHUB_SHA || plan.base !== base ||
      JSON.stringify(plan.files) !== JSON.stringify(changedPaths(base, cwd).sort()))) {
    throw new Error('PR plan does not match tested merge changes');
  }
  return base;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const event = process.env.CI_EVENT;
  const base = resolveCiBase();
  let paths;
  if (!['workflow_dispatch', 'schedule'].includes(event)) {
    paths = changedPaths(base);
  }
  const plan = planCi({ event, sha: process.env.GITHUB_SHA, approvedSha: process.env.CI_RELEASE_SHA, ref: process.env.CI_REF, paths, base });
  console.log(JSON.stringify(plan, null, 2));
  appendFileSync(process.env.GITHUB_OUTPUT, `plan=${JSON.stringify(plan)}\nfamilies=${JSON.stringify(plan.families)}\nmode=${plan.mode}\nrelease=${plan.mode === 'release'}\nbuild=${needsBuild(plan)}\n`);
}
