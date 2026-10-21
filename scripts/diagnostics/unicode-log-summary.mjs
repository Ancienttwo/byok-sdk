import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [source, destination] = process.argv.slice(2);
const allowed = new Set(['unknown', 'stopped', 'awaiting-enrollment', 'running', 'halted', 'crashed', 'open', 'connecting', 'unpaired', 're_pair_required', 'store_owned', 'device_revoked', 'handshake_rejected', 'replay_cursor_too_old', 'config_invalid', 'Offered', 'Claimed', 'Running', 'AwaitApproval', 'Complete', 'Failed', 'Cancelled', 'queued', 'inflight', 'backoff', 'memory_blocked', 'settled', 'succeeded', 'failed', 'declined', 'cancelled', 'expired', 'superseded']);
const keys = new Set(['lifecycle', 'phase', 'connection', 'reasonCode', 'activeTaskCount', 'pendingTerminalCommits', 'profileProjectionReady', 'taskState', 'intentPresent', 'intentPhase', 'intentConclusion', 'intentAttempts', 'adapterStarts', 'adapterSessions', 'matchingAdapterStarts', 'adapterSessionPresent', 'collectionFailed']);
function safe(value) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === 'string') return allowed.has(value) ? value : 'unknown';
  if (value && typeof value === 'object' && !Array.isArray(value)) return Object.fromEntries(Object.entries(value).filter(([key]) => keys.has(key)).map(([key, item]) => [key, safe(item)]));
  return null;
}
const result = [];
for (const name of readdirSync(source).filter(name => /^(install|build|group-chat)\.log$/.test(name))) {
  result.push(`phase=${name.slice(0, -4)}`);
  for (const raw of readFileSync(join(source, name), 'utf8').split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    const stageMarker = line.indexOf('BYOK_UNICODE_STAGE ');
    if (stageMarker >= 0) {
      try {
        const value = JSON.parse(line.slice(stageMarker + 'BYOK_UNICODE_STAGE '.length));
        const stages = ['offer-enter', 'message-preflight-before', 'message-preflight-after', 'result-preflight-before', 'result-preflight-after', 'adapter-prepare-before', 'adapter-prepare-after', 'start-before', 'start-after', 'home-acquire-before', 'home-acquire-after', 'home-initialize-before', 'home-initialize-after', 'result-store-before', 'result-store-after', 'manifest-before', 'manifest-after', 'claim-before', 'instruction-after'];
        if (stages.includes(value.stage) && Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= 0) {
          result.push('BYOK_UNICODE_STAGE ' + JSON.stringify({ stage: value.stage, elapsedMs: value.elapsedMs }));
        }
      } catch { /* Reject malformed diagnostic input without echoing it. */ }
    }
    const marker = line.indexOf('BYOK_UNICODE_DIAGNOSTIC ');
    if (marker >= 0) {
      try { result.push(`BYOK_UNICODE_DIAGNOSTIC ${JSON.stringify(safe(JSON.parse(line.slice(marker + 24))))}`); }
      catch { result.push('BYOK_UNICODE_DIAGNOSTIC {"collectionFailed":true}'); }
    }
    const summary = line.match(/(?:Test Files|Tests)\s+((?:\d+ (?:passed|failed|skipped|todo)(?: \| )?)+)(?: \(\d+\))?$/);
    if (summary) result.push(summary[0]);
  }
}
writeFileSync(destination, result.join('\n') + '\n');
