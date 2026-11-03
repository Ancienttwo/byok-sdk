// DIAG #1317 -- do not merge. E1g: counts the instrumented reader's log by
// outcome class. Usage: node e1g-summary.mjs <label> <log>
import { existsSync, readFileSync } from 'node:fs';

const [label, log] = process.argv.slice(2);
const lines = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
const counts = new Map();
let slowest = 0;
for (const entry of lines) {
  const cls = entry.ok ? `ok:${entry.step}` : `fail:${entry.step}:${entry.name}:${entry.code}:killed=${entry.killed}:signal=${entry.signal}${entry.icacls ? `:${entry.icacls}` : ''}`;
  counts.set(cls, (counts.get(cls) ?? 0) + 1);
  slowest = Math.max(slowest, entry.ms);
}
console.log(`[e1g] SUMMARY ${label} entries=${lines.length} slowest_ms=${slowest}`);
for (const [cls, count] of [...counts].sort()) console.log(`[e1g] SUMMARY ${label} ${count} ${cls}`);
const fails = lines.filter((entry) => !entry.ok);
for (const entry of fails) console.log(`[e1g] FAIL ${label} ${JSON.stringify(entry)}`);
