import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
const refs = { baseline: '12a11bcfa8c711587c91f830d29457937a8d0ae9', candidate: '21c935b7bfae1d5d7161beb956167b9650b96160' };
const paths = process.argv.slice(2);
const check = paths[0] === '--check';
if (check) paths.shift();
if (paths.length !== 2) throw new Error('Expected baseline and candidate directories');
const replace = (s, a, b) => {
  if (s.split(a).length !== 2) throw new Error('Diagnostic anchor mismatch');
  return s.replace(a, b);
};
const support = `
// Failure-only diagnostic: identity is compared in memory, never printed.
const diagnosticClose = new WeakMap<object, { entered: boolean; returned: boolean }>();
function observeDiagnosticSession<T extends { close(): Promise<void> }>(session: T): T {
  if (!diagnosticClose.has(session)) {
    const state = { entered: false, returned: false };
    diagnosticClose.set(session, state);
    const close = session.close.bind(session);
    session.close = async () => { state.entered = true; await close(); state.returned = true; };
  }
  return session;
}
function diagnosticSnapshot(host: TestHost | undefined, owner: BotCollaboration | undefined,
  id: string | undefined, stage: string, existing: ReadonlySet<string> = new Set()) {
  try {
    const intent = id ? owner?.core.intent(id) : undefined;
    const task = intent?.taskId;
    const session = task ? host?.adapter.sessions.get(task) : undefined;
    const manifest = host?.adapter.starts.find(start => start.manifest.taskId === task)?.manifest;
    const newer = host?.adapter.starts.filter(start => !existing.has(start.manifest.taskId)) ?? [];
    const status = host?.daemon.status();
    const close = session ? diagnosticClose.get(session) : undefined;
    const sessions = [...(host?.adapter.sessions.values() ?? [])];
    console.error('BYOK_WRITER_FAILURE ' + JSON.stringify({
      stage, sessionCount: sessions.length,
      closedSessionCount: sessions.filter(item => item.closed).length,
      closeReturnedSessionCount: sessions.filter(item => diagnosticClose.get(item)?.returned).length,
      intentPresent: !!intent, sequence: intent?.sequence,
      succeeded: id ? owner?.snapshot().turns[id]?.status === 'succeeded' : false,
      phase: intent?.phase, sessionPresent: !!session, sessionClosed: session?.closed === true,
      closeEntered: close?.entered === true, closeReturned: close?.returned === true,
      activeTaskCount: status?.activeTaskCount, pendingTerminalCommits: status?.pendingTerminalCommits,
      activeHomeAttempts: status?.agentHomeExecution.activeAttempts,
      oldWriter: !!manifest && manifest.homeAccess === undefined, oldLeasePresent: !!manifest?.lease,
      newerSessionCount: newer.length,
      sameHomeNewWriter: newer.some(({ manifest: next }) => next.homeAccess === undefined
        && !!manifest?.lease && next.lease?.canonicalHome === manifest.lease.canonicalHome),
      distinctSameHomeNewLease: newer.some(({ manifest: next }) => next.homeAccess === undefined
        && !!manifest?.lease && next.lease?.canonicalHome === manifest.lease.canonicalHome
        && next.lease.leaseId !== manifest.lease.leaseId),
    }));
  } catch { console.error('BYOK_WRITER_FAILURE ' + JSON.stringify({ stage, collectionFailed: true })); }
}
`;
for (const [index, [label, sha]] of Object.entries(refs).entries()) {
  const cwd = resolve(paths[index]);
  if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim() !== sha) throw new Error('Source SHA mismatch');
  for (const file of ['coalesce-host.test.ts', 'acceptance.test.ts']) {
    const filename = resolve(cwd, 'examples/bot-collaboration/src', file);
    const before = readFileSync(filename, 'utf8');
    let source = before;
    const isCoalesce = file.startsWith('coalesce');
    const signature = isCoalesce ? 'async function finish(id: string, document: unknown = {}) {' : 'async function finish(id: string, outcome: unknown = {}) {';
    source = replace(source, signature, signature.replace('finish(', 'finishObserved('));
    if (isCoalesce && label === 'baseline') {
      source = replace(source, '  await (await running(id)).finish(document);', '  await observeDiagnosticSession(await running(id)).finish(document);');
    } else if (isCoalesce) {
      source = replace(source, '  const session = await running(id);\n  const current =', '  const session = observeDiagnosticSession(await running(id));\n  const current =');
    } else {
      source = replace(source, '  const session = fixture!.adapter.sessions.get(bot!.core.intent(id)!.taskId)!;', '  const session = observeDiagnosticSession(fixture!.adapter.sessions.get(bot!.core.intent(id)!.taskId)!);');
    }
    if (isCoalesce) {
      source = replace(source, "draft: { text: 'hello' } }] });", "draft: { text: 'hello' } }] }, 'setup-turn');");
      source = replace(source, "await finish(first, { delegate: [{ to: 'main', request: 'Continue the long task' }] });", "await finish(first, { delegate: [{ to: 'main', request: 'Continue the long task' }] }, 'busy-turn');");
    }
    // Bind teardown observations to this test's objects, not mutable module globals.
    const originalHook = isCoalesce
      ? 'afterEach(async () => { await bot?.close(); await fixture?.close(); });'
      : 'afterEach(async () => { await bot?.close(); await fixture?.close(); vi.restoreAllMocks(); });';
    source = replace(source, originalHook, `afterEach(async context => {
  const owner = bot, host = fixture;
  let stage = 'bot-close';
  let failed = false;
  const lateBinding = () => { if (failed) console.error('BYOK_LATE_TEARDOWN_BINDING ' + JSON.stringify({
    stage, ownerChanged: bot !== owner, fixtureChanged: fixture !== host })); };
  let ownerChangedAfterBotClose = false, fixtureChangedAfterBotClose = false;
  let ownerChangedAfterFixtureClose = false, fixtureChangedAfterFixtureClose = false;
  context.onTestFailed(() => {
    failed = true;
    diagnosticSnapshot(host, owner, undefined, 'teardown-' + stage);
    console.error('BYOK_TEARDOWN_BINDING ' + JSON.stringify({ stage,
      ownerChanged: bot !== owner, fixtureChanged: fixture !== host,
      ownerChangedAfterBotClose, fixtureChangedAfterBotClose,
      ownerChangedAfterFixtureClose, fixtureChangedAfterFixtureClose }));
  });
  // Preserve the original mutable-global reads; capturing calls would fix the race under diagnosis.
  await bot?.close();
  ownerChangedAfterBotClose = bot !== owner; fixtureChangedAfterBotClose = fixture !== host;
  stage = 'fixture-close'; lateBinding();
  await fixture?.close();
  ownerChangedAfterFixtureClose = bot !== owner; fixtureChangedAfterFixtureClose = fixture !== host;
  stage = 'complete'; lateBinding();
  ${isCoalesce ? '' : 'vi.restoreAllMocks();'}
});`);
    source += support + `
async function finish(id: string, document: unknown = {}, stage = 'other-turn') {
  const host = fixture, owner = bot;
  const existing = new Set(host?.adapter.starts.map(start => start.manifest.taskId));
  try { await finishObserved(id, document); }
  catch (error) { diagnosticSnapshot(host, owner, id, stage, existing); throw error; }
}
`;
    // Check expect-call count/order and timeout literal tokens only.
    // Manual diff review, not this token check, verifies full assertion expressions.
    const tokens = s => [...s.matchAll(/timeout:\s*\d+|expect\(/g)].map(m => m[0]);
    if (JSON.stringify(tokens(before)) !== JSON.stringify(tokens(source))) throw new Error('Assertion or timeout modified');
    if (!check) writeFileSync(filename, source);
    console.log(`BYOK_DIAGNOSTIC_ANCHORS ${label} ${file} preserved`);
  }
  if (check) continue;
  console.log(`BYOK_DIAGNOSTIC_SOURCE ${label} ${sha}`);
  for (const args of [['ci'], ['run', '--filter', './packages/*', '--if-present', 'build']]) {
    const result = spawnSync('bun', args, { cwd, stdio: 'inherit', env: process.env });
    if (result.error || result.status !== 0) throw new Error(`${label} setup failed`);
  }
  // Keep the same observed order for both sides; no test bodies or timeouts change.
  const orderPath = resolve(cwd, 'examples/bot-collaboration/diagnostic-sequencer.ts');
  writeFileSync(orderPath, `import { BaseSequencer } from 'vitest/node';
export default class DiagnosticOrder extends BaseSequencer {
  async sort(tests: Parameters<BaseSequencer['sort']>[0]) {
    return [...tests].sort((a, b) => Number(a.moduleId.includes('acceptance.test')) - Number(b.moduleId.includes('acceptance.test')));
  }
}
`);
  const args = ['run', '--cwd', 'examples/bot-collaboration', 'test', '--',
    'src/coalesce-host.test.ts', 'src/acceptance.test.ts', '--sequence.sequencer=./diagnostic-sequencer.ts'];
  const result = spawnSync('bun', args, { cwd, stdio: 'inherit', env: process.env });
  console.log(`BYOK_DIAGNOSTIC_TEST_EXIT ${label} ${result.status ?? 1}`);
  if (result.error || result.status !== 0) process.exitCode = 1;
}
