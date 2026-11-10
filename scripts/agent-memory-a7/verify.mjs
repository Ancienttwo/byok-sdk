import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { BEFORE, SCHEMA, parseJson, readEvidence, validateProfile } from './evidence.mjs';

export function bridge(repo, operation, input) {
  const result = spawnSync('bun', [fileURLToPath(new URL('bridge.mjs', import.meta.url)), repo, operation], {
    input: JSON.stringify(input), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`strict checker failed: ${result.stderr || result.error}`);
  return parseJson(result.stdout, 'strict checker output');
}

export function verify(rows, repo) {
  const metadata = rows[0]?.event;
  if (metadata?.kind !== 'metadata' || metadata.schema !== SCHEMA) throw new Error('missing A7 metadata');
  validateProfile(metadata.storageProfile);
  if (metadata.before !== BEFORE || !/^[a-f0-9]{40}$/.test(metadata.revision)
    || !['before', 'after'].includes(metadata.role)
    || (metadata.role === 'before' && metadata.revision !== BEFORE)
    || (metadata.role === 'after' && metadata.revision === BEFORE)
    || !['process-kill', 'owner-vm-power-cut'].includes(metadata.mode)
    || !Array.isArray(metadata.triggers) || metadata.triggers.length === 0) throw new Error('invalid revision or schedule metadata');
  // Always verify with the known #998-correct checker. The candidate cannot
  // provide its own acceptance rules.
  const sha = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const gitStatus = spawnSync('git', ['-C', repo, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
  if (sha.status !== 0 || sha.stdout.trim() !== BEFORE || gitStatus.status !== 0 || gitStatus.stdout.trim() !== '') throw new Error('verifier repository must be the clean pinned before revision');
  if (metadata.mode === 'owner-vm-power-cut' && (typeof metadata.ownerAuthorization !== 'string' || metadata.ownerAuthorization.trim() === '')) throw new Error('missing owner VM authorization record');
  const failures = [];
  const journal = [];
  const issued = new Set();
  const cuts = [];
  let identities = 0;
  let snapshots = 0;
  let cleanup;
  let report;
  let cutRequests = 0;
  let cutConfirmations = 0;
  for (const { event } of rows.slice(1)) {
    if (event.kind === 'journal') {
      const entry = event.entry;
      if (entry.kind === 'issued') {
        if (issued.has(entry.intent.intentId)) throw new Error('duplicate issued intent');
        issued.add(entry.intent.intentId);
      } else if (['receipt', 'acked', 'repeat', 'failed'].includes(entry.kind) && !issued.has(entry.intentId)) {
        throw new Error('Host evidence references an unissued intent');
      }
      if (entry.kind === 'failed' || (entry.kind === 'repeat' && entry.disposition === 'conflict')) failures.push(entry);
      journal.push(entry);
    } else if (event.kind === 'identity') {
      if (event.boot !== identities++ || event.revision !== metadata.revision
        || event.helperManifestDigest !== metadata.helperManifestDigest
        || event.osBuild !== metadata.storageProfile.osBuild) throw new Error('guest identity/profile mismatch');
    } else if (event.kind === 'snapshot') {
      if (event.boot !== snapshots || identities !== snapshots + 1) throw new Error('missing or unordered reboot snapshot');
      const cutCount = journal.filter((entry) => entry.kind === 'cut').length;
      if (cutCount !== snapshots) throw new Error('snapshot has no matching cut');
      if (metadata.mode === 'owner-vm-power-cut' && (event.snapshot.platform !== 'win32' || event.snapshot.arch !== 'x64')) throw new Error('A7 requires a Windows x64 guest');
      if (snapshots === 0 && event.snapshot.homes.length !== 0) throw new Error('experiment store was not fresh');
      if (snapshots > 0) {
        const check = bridge(repo, 'check', { snapshot: event.snapshot, journal });
        cuts.push(check);
        for (const invariant of check.invariants) {
          if (invariant.status !== 'held') failures.push({ boot: snapshots, ...invariant });
        }
      }
      snapshots++;
    } else if (event.kind === 'cleanup') {
      cleanup = event;
      if (event.boot !== snapshots - 1) throw new Error('cleanup boot mismatch');
    } else if (event.kind === 'report') {
      if (report !== undefined) throw new Error('duplicate experiment report');
      report = event.report;
    } else if (event.kind === 'cut-request') cutRequests++;
    else if (event.kind === 'cut-confirmed') {
      if (event.confirmation !== 'CUT' || cutRequests !== cutConfirmations + 1) throw new Error('invalid owner cut confirmation');
      cutConfirmations++;
    } else throw new Error(`unknown evidence event ${event.kind}`);
  }
  if (rows.at(-1)?.event.kind !== 'report' || !report) failures.push('experiment did not finish');
  if (report?.stoppedEarly || report?.violations !== 0) failures.push('experiment reported a failure');
  const recordedCuts = journal.filter((entry) => entry.kind === 'cut');
  if (metadata.mode === 'owner-vm-power-cut' && (cutRequests !== recordedCuts.length || cutConfirmations !== recordedCuts.length)) failures.push('owner cut requests/confirmations do not match observed cuts');
  if (identities !== snapshots) failures.push('guest identity has no snapshot');
  if (recordedCuts.length !== metadata.triggers.length || cuts.length !== metadata.triggers.length
    || report?.cuts.length !== cuts.length) failures.push('incomplete trigger schedule/reboot verification');
  for (const [index, entry] of recordedCuts.entries()) {
    if (entry.round !== index || entry.trigger !== metadata.triggers[index]) failures.push('cut schedule mismatch');
  }
  // Cleanup is observed only after all recovery and an explicit helper reopen
  // of every existing home; raw pre-recovery leftovers are counted separately.
  if (!cleanup || cleanup.boot !== metadata.triggers.length) failures.push('missing final helper cleanup snapshot');
  else {
    const final = bridge(repo, 'check', { snapshot: cleanup.snapshot, journal });
    for (const invariant of final.invariants) if (invariant.status !== 'held') failures.push({ phase: 'cleanup', ...invariant });
    if (final.leftovers !== 0) failures.push({ phase: 'cleanup', leftovers: final.leftovers });
    const expected = new Set(journal.filter((entry) => entry.kind === 'issued').map((entry) => entry.intent.agentRef.agentId));
    for (const home of cleanup.snapshot.homes) expected.delete(home.agentId);
    if (expected.size !== 0) failures.push('cleanup lost an issued Agent home');
  }
  const acked = new Set(journal.filter((entry) => entry.kind === 'acked').map((entry) => entry.intentId));
  if ([...issued].some((id) => !acked.has(id))) failures.push('recovery left an intent unacknowledged');
  const processKill = metadata.mode === 'process-kill';
  let evidence = 'harness-validation-not-A7';
  if (!processKill) evidence = metadata.storageProfile.dropsUnflushedWrites ? 'profile-limited-power-loss' : 'profile-limited-vm-power-off';
  return {
    schema: SCHEMA, role: metadata.role, before: BEFORE, revision: metadata.revision,
    mode: metadata.mode, storageProfile: metadata.storageProfile,
    helperManifestDigest: metadata.helperManifestDigest,
    seed: metadata.seed, triggers: metadata.triggers,
    evidence,
    status: failures.length === 0 ? 'passed' : 'failed',
    cuts, completeReceipts: journal.filter((entry) => entry.kind === 'receipt').length,
    acked: acked.size, cleanup: cleanup ? cleanup.snapshot.homes.flatMap((home) => home.leftovers) : null,
    failures, evidenceDigest: rows.at(-1)?.digest,
  };
}

export function compare(before, after) {
  if (before.role !== 'before' || after.role !== 'after' || before.revision !== BEFORE || after.before !== BEFORE
    || !/^[a-f0-9]{40}$/.test(after.revision) || after.revision === BEFORE) throw new Error('expected pinned before and distinct after results');
  for (const key of ['schema', 'mode', 'storageProfile', 'seed', 'triggers']) {
    if (!isDeepStrictEqual(before[key], after[key])) throw new Error(`before/after ${key} differs`);
  }
  return { schema: SCHEMA, before, after, status: before.status === 'passed' && after.status === 'passed' ? 'passed' : 'failed', scope: 'Recorded storage profile only; owner acceptance and Windows intent B remain separate.' };
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  let result;
  if (command === 'verify' && args.length === 3) result = verify(readEvidence(args[0]), path.resolve(args[1]));
  else if (command === 'compare' && args.length === 3) result = compare(...args.slice(0, 2).map((file) => parseJson(readFileSync(file, 'utf8'), file)));
  else throw new Error('usage: node verify.mjs verify <evidence.jsonl> <before-checkout> <result.json> | compare <before.json> <after.json> <comparison.json>');
  writeFileSync(args[2], `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' });
  console.log(`${result.evidence ?? result.scope}: ${result.status}`);
  process.exitCode = result.status === 'passed' ? 0 : 1;
}
