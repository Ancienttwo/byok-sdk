import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const refs = ['1e5326eb38a3476d1a69733a43a5adb3526eba45', 'd53a0c3f32cf552316f14e49df91322f0b185a33'];
const args = process.argv.slice(2), check = args[0] === '--check';
if (check) args.shift();
if (args.length !== 2) throw new Error('Expected baseline and candidate dirs');
const norm = s => s.replace(/\r\n/g, '\n');
const helper = norm(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'k8-failure-diagnostics.ts'), 'utf8'));
const original = `async function finish(id: string, outcome: unknown = {}) {
  await vi.waitFor(() => expect(fixture!.adapter.sessions.has(bot!.core.intent(id)!.taskId)).toBe(true), { timeout: 5000 });
  fixture!.adapter.sessions.get(bot!.core.intent(id)!.taskId)!.finish(outcome);
  await vi.waitFor(async () => { await bot!.drain(); expect(bot!.snapshot().turns[id]?.status).toBe('succeeded'); }, { timeout: 5000 });
}`;
const replacement = `let diagnosticInvocation = 0;
const diagnosticPreparation = new WeakMap<object, { entered: number; settled: number; rejected: number }>();
async function finish(id: string, outcome: unknown = {}) {
  const host = fixture!, owner = bot!, invocation = ++diagnosticInvocation;
  const receipt: FinishReceipt = { state: 'not-called' };
  const collect = async (predicate: 'session-present' | 'semantic-succeeded') => ({
    ...await k8FailureSnapshot(host, owner, id, predicate, receipt), invocation,
    fixtureUnchanged: fixture === host, botUnchanged: bot === owner,
    preparation: diagnosticPreparation.get(host) ?? null,
  });
  await withK8FailureSnapshot(vi.waitFor(() => expect(fixture!.adapter.sessions.has(bot!.core.intent(id)!.taskId)).toBe(true), { timeout: 5000 }), () => collect('session-present'));
  trackFinishReceipt(fixture!.adapter.sessions.get(bot!.core.intent(id)!.taskId)!.finish(outcome), receipt);
  await withK8FailureSnapshot(vi.waitFor(async () => { await bot!.drain(); expect(bot!.snapshot().turns[id]?.status).toBe('succeeded'); }, { timeout: 5000 }), () => collect('semantic-succeeded'));
}`;
const hook = 'afterEach(async () => { await bot?.close(); await fixture?.close(); vi.restoreAllMocks(); });';
const hookReplacement = `afterEach(async context => {
  const owner = bot, host = fixture;
  let stage = 'bot-close', failed = false;
  const snapshot = () => ({ stage, botUnchanged: bot === owner, fixtureUnchanged: fixture === host });
  context.onTestFailed(() => { failed = true; console.error('[k8-cleanup-failure]', JSON.stringify(snapshot())); });
  // Preserve the original mutable-global calls and await order.
  await bot?.close(); stage = 'fixture-close';
  if (failed) console.error('[k8-late-cleanup]', JSON.stringify(snapshot()));
  await fixture?.close(); stage = 'complete';
  if (failed) console.error('[k8-late-cleanup]', JSON.stringify(snapshot()));
  vi.restoreAllMocks();
});`;
const setupAnchor = '  const base = template(fixture.deviceId);';
const setupReplacement = `  const preparation = { entered: 0, settled: 0, rejected: 0 };
  diagnosticPreparation.set(fixture, preparation);
  const originalPrepare = fixture.adapter.prepare.bind(fixture.adapter);
  vi.spyOn(fixture.adapter, 'prepare').mockImplementation(input => {
    preparation.entered++;
    const pending = originalPrepare(input);
    void pending.then(() => { preparation.settled++; }, () => { preparation.rejected++; });
    return pending;
  });
  const base = template(fixture.deviceId);`;
const header = "import { k8FailureSnapshot, trackFinishReceipt, withK8FailureSnapshot, type FinishReceipt } from './k8-failure-diagnostics';\n";
const relative = 'examples/bot-collaboration/src/acceptance.test.ts';
function overlay(raw) {
  const before = norm(raw);
  for (const anchor of [original, hook, setupAnchor]) if (before.split(anchor).length !== 2) throw new Error('Anchor mismatch');
  const after = header + before.replace(original, replacement).replace(hook, hookReplacement).replace(setupAnchor, setupReplacement);
  if (after.slice(header.length).replace(replacement, original).replace(hookReplacement, hook).replace(setupReplacement, setupAnchor) !== before) throw new Error('Non-diagnostic mutation');
  const tokens = s => [...s.matchAll(/expect\(|timeout:\s*\d+|interval:\s*\d+/g)].map(m => m[0]);
  if (JSON.stringify(tokens(before)) !== JSON.stringify(tokens(after))) throw new Error('Assertion/deadline changed');
  return after;
}
const plans = refs.map((sha, i) => {
  const cwd = resolve(args[i]);
  if (execFileSync('git', ['rev-parse', 'HEAD'], {cwd, encoding:'utf8'}).trim() !== sha) throw new Error('Wrong HEAD');
  const raw = readFileSync(resolve(cwd, relative), 'utf8');
  if (norm(raw) !== norm(execFileSync('git', ['show', `${sha}:${relative}`], {cwd, encoding:'utf8'}))) throw new Error('Modified source');
  const after = overlay(raw);
  if (after !== overlay(norm(raw).replace(/\n/g, '\r\n'))) throw new Error('CRLF differs');
  console.log(`K8_DIAG_CHECK ${sha} exact-source/assertions/deadlines/CRLF`);
  return {cwd, sha, after};
});
console.log('K8_DIAG_HELPER_SHA256',createHash('sha256').update(helper).digest('hex'));
if (!check) {
  let failed = false;
  const pattern = '^(keeps an expired card in the next ContextPack without creating a model turn|bounds an uncooperative connector and releases queued input, answer, decision and wake calls)$';
  for (const {cwd,sha,after} of plans) {
    writeFileSync(resolve(cwd,relative),after);
    writeFileSync(resolve(cwd,'examples/bot-collaboration/src/k8-failure-diagnostics.ts'),helper);
    let ready = true;
    for (const argv of [['ci'],['run','--filter','./packages/*','--if-present','build']]) {
      const r = spawnSync('bun',argv,{cwd,stdio:'inherit'});
      console.log('K8_DIAG_SETUP_EXIT',sha,argv[0],r.status??1);
      if (r.error || r.status!==0) {failed=true;ready=false;break;}
    }
    if (!ready) {console.log('K8_DIAG_NOT_RUN',sha);continue;}
    // Same file/process, original source order, only the two failing cases.
    const r = spawnSync('bun',['run','--cwd','examples/bot-collaboration','test','src/acceptance.test.ts','-t',pattern],{cwd,stdio:'inherit'});
    console.log('K8_DIAG_TEST_EXIT',sha,r.status??1);
    if (r.error || r.status!==0) failed=true;
  }
  if(failed) process.exitCode=1;
}
