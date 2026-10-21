import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const refs = { candidate: 'c0fae66071f1633874fc89ad961459a360855b60' };
const [label, directory, mode] = process.argv.slice(2);
if (!Object.hasOwn(refs, label)) throw new Error('Unknown diagnostic side');
const cwd = resolve(directory);
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim() !== refs[label]) throw new Error('Diagnostic source SHA mismatch');
const filename = resolve(cwd, 'examples/bot-collaboration/src/coalesce-host.test.ts');
let source = readFileSync(filename, 'utf8');
function replaceExact(before, after) {
  if (source.split(before).length !== 2) throw new Error('Diagnostic fixture anchor mismatch');
  source = source.replace(before, after);
}
replaceExact('async function finish(id: string, document: unknown = {}) {', `async function finish(id: string, document: unknown = {}, diagnosticStage?: 'setup-turn' | 'busy-turn') {`);
const assertion = "  await vi.waitFor(async () => { await bot.drain(); expect(bot.snapshot().turns[id]?.status).toBe('succeeded'); }, { timeout: 5000 });";
replaceExact(assertion, `  try {\n${assertion}\n  } catch (error) {
    if (diagnosticStage) {
      try { await failedFinishSnapshot(id, diagnosticStage); }
      catch { console.log('BYOK_COALESCE_DIAG ' + JSON.stringify({ stage: diagnosticStage, collectionFailed: true })); }
    }
    throw error;
  }`);
replaceExact("draft: { text: 'hello' } }] });", "draft: { text: 'hello' } }] }, 'setup-turn');");
replaceExact("await finish(first, { delegate: [{ to: 'main', request: 'Continue the long task' }] });", "await finish(first, { delegate: [{ to: 'main', request: 'Continue the long task' }] }, 'busy-turn');");
source += `
// Diagnostic-only: runs after the unchanged assertion fails; never logs identities or content.
async function failedFinishSnapshot(id: string, stage: 'setup-turn' | 'busy-turn') {
  const choice = (value: unknown, allowed: readonly string[]) => typeof value === 'string' && allowed.includes(value) ? value : 'unknown';
  const intent = bot.core.intent(id);
  const execution = intent && fixture.ledger.snapshot().executions[intent.taskId];
  const session = intent && fixture.adapter.sessions.get(intent.taskId);
  const active = fixture.daemon.status().activeTaskCount;
  const bound = async <T>(read: () => Promise<T>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([read().then(value => ({ ok: true as const, value })),
      new Promise<{ ok: false }>(resolve => { timer = setTimeout(() => resolve({ ok: false }), 250); })]); }
    catch { return { ok: false as const }; }
    finally { if (timer) clearTimeout(timer); }
  };
  const [attempt, terminal] = await Promise.all([
    bound(() => intent ? fixture.server.tasks.attempt(intent.taskId) : Promise.resolve(undefined)),
    bound(() => intent ? fixture.server.tasks.deviceTerminal(intent.taskId) : Promise.resolve(undefined)),
  ]);
  console.log('BYOK_COALESCE_DIAG ' + JSON.stringify({
    stage,
    intentPresent: !!intent,
    phase: choice(intent?.phase, ['queued', 'inflight', 'backoff', 'memory_blocked', 'settled']),
    conclusion: choice(intent?.conclusion, ['succeeded', 'failed', 'declined', 'cancelled', 'expired', 'superseded']),
    submission: choice(execution?.submission, ['reserved', 'uncertain', 'delivered']),
    executionStarted: execution?.started === true,
    ledgerTerminalPresent: !!execution?.terminal,
    attemptAvailable: attempt.ok,
    attemptPresent: attempt.ok && !!attempt.value,
    attemptStatus: choice(attempt.ok ? attempt.value?.status : undefined, ['pending', 'offered', 'claimed', 'running', 'completed', 'failed', 'cancelled', 'declined', 'expired']),
    terminalAvailable: terminal.ok,
    terminalPresent: terminal.ok && !!terminal.value,
    terminalType: choice(terminal.ok ? terminal.value?.envelope.type : undefined, ['task.complete', 'task.fail', 'task.cancelled', 'task.decline']),
    activeTaskCount: Number.isSafeInteger(active) && active >= 0 ? active : 0,
    sessionPresent: !!session,
    sessionClosed: session?.closed === true,
  }));
}
`;
if (mode === '--check') {
  const originalAssertCount = readFileSync(filename, 'utf8').split(assertion).length - 1;
  if (originalAssertCount !== 1 || source.split(assertion).length !== 2) throw new Error('Original assertion not preserved');
  console.log(`Diagnostic anchors and original assertion verified: ${label}`);
  process.exit(0);
}
writeFileSync(filename, source);
console.log(`BYOK_COALESCE_SOURCE ${label} ${refs[label]}`);
for (const args of [
  ['ci'],
  ['run', '--filter', './packages/*', '--if-present', 'build'],
]) {
  const result = spawnSync('bun', args, { cwd, stdio: 'inherit', env: process.env });
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}
for (const args of [
  ['run', '--cwd', 'examples/bot-collaboration', 'test', '--', 'src/coalesce-fixture.test.ts'],
  ['run', '--cwd', 'examples/bot-collaboration', 'test', '--', 'src/coalesce-host.test.ts', '-t', '^seals the open batch before answer, action_result, routine and continuation Turns, in arrival order \\(S5\\)$'],
]) {
  const result = spawnSync('bun', args, { cwd, stdio: 'inherit', env: process.env });
  console.log(`BYOK_COALESCE_TEST_EXIT ${args[5]} ${result.status ?? 1}`);
  if (result.error || result.status !== 0) process.exitCode = result.status ?? 1;
}
