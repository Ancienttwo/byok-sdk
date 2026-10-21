import { pathToFileURL } from 'node:url';
import { knownFamilies, selectImpact } from './select-impact.mjs';
import { requireCiSuccess } from './require-ci-success.mjs';

export function requireCiPlan(needs, plan, event, sha) {
  const inventory = ['select', 'targeted', ...knownFamilies];
  if (!needs || JSON.stringify(Object.keys(needs).sort()) !== JSON.stringify(inventory.sort())) throw new Error('CI inventory mismatch');
  if (needs.select.result !== 'success' || !plan || plan.sha !== sha) throw new Error('Missing successful exact-SHA selection');
  const release = event === 'workflow_dispatch';
  if (plan.mode !== (release ? 'release' : 'targeted')) throw new Error('CI mode mismatch');
  const families = release ? knownFamilies : selectImpact(plan.files).families;
  if (JSON.stringify([...families].sort()) !== JSON.stringify([...plan.families].sort())) throw new Error('CI selection mismatch');
  const required = ['select', ...(release ? [] : ['targeted']), ...families];
  for (const id of inventory) {
    if (!required.includes(id) && needs[id].result !== 'skipped') throw new Error(`Unselected CI job unexpectedly ran: ${id}`);
  }
  requireCiSuccess(Object.fromEntries(required.map(id => [id, needs[id]])), required);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  requireCiPlan(JSON.parse(process.env.CI_NEEDS ?? ''), JSON.parse(process.env.CI_PLAN ?? ''), process.env.CI_EVENT, process.env.GITHUB_SHA);
  console.log('Selected CI scope succeeded; only explicit release mode qualifies the complete matrix');
}
