import { isReleaseRef, verifyPrPlan } from './plan-ci.mjs';
import { pathToFileURL } from 'node:url';
import { knownFamilies, selectImpact } from './select-impact.mjs';
import { requireCiSuccess } from './require-ci-success.mjs';

export function requireCiPlan(needs, plan, event, sha, base, cwd) {
  const inventory = ['select', 'targeted', ...knownFamilies];
  if (!needs || JSON.stringify(Object.keys(needs).sort()) !== JSON.stringify(inventory.sort())) throw new Error('CI inventory mismatch');
  if (needs.select.result !== 'success' || !plan || plan.sha !== sha) throw new Error('Missing successful exact-SHA selection');
  const mode = event === 'workflow_dispatch' ? 'release' : event === 'schedule' ? 'nightly' : 'targeted';
  const full = mode !== 'targeted';
  if (plan.mode !== mode) throw new Error('CI mode mismatch');
  if (!full && plan.base !== base) throw new Error('CI comparison base mismatch');
  const families = full ? knownFamilies : selectImpact(plan.files, { base, cwd }).families;
  if (JSON.stringify([...families].sort()) !== JSON.stringify([...plan.families].sort())) throw new Error('CI selection mismatch');
  const required = ['select', ...(full ? [] : ['targeted']), ...families];
  for (const id of inventory) {
    if (!required.includes(id) && needs[id].result !== 'skipped') throw new Error(`Unselected CI job unexpectedly ran: ${id}`);
  }
  requireCiSuccess(Object.fromEntries(required.map(id => [id, needs[id]])), required);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const plan = JSON.parse(process.env.CI_PLAN ?? '');
  if (process.env.CI_EVENT === 'workflow_dispatch' && !isReleaseRef(process.env.CI_REF)) throw new Error('Release validation runs only on main or release/* refs');
  if (process.env.CI_EVENT === 'schedule' && process.env.CI_REF !== 'refs/heads/main') throw new Error('Nightly validation runs only on main');
  const base = verifyPrPlan(plan);
  requireCiPlan(JSON.parse(process.env.CI_NEEDS ?? ''), plan, process.env.CI_EVENT, process.env.GITHUB_SHA, base);
  console.log('Selected CI scope succeeded; full nightly and release modes require every family');
}
