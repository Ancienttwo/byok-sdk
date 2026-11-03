// DIAG #1317 -- do not merge. E1g: 200 real readWindowsRegistryKey calls in
// series, then 200 at concurrency 8 (alternating machine and user key) while
// e1g-stress.mjs saturates every CPU. The instrumented reader logs each call;
// this prints the counts per round. Run with bun (it loads the TS source).
// Usage: bun e1g-reads.mjs <impl checkout> <round: serial|parallel>
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [root, round] = process.argv.slice(2);
const { readWindowsRegistryKey, WINDOWS_MACHINE_ENVIRONMENT_KEY, WINDOWS_USER_ENVIRONMENT_KEY } = await import(pathToFileURL(path.join(root, 'packages', 'client', 'src', 'runtime', 'environment.ts')).href);
const keys = [WINDOWS_MACHINE_ENVIRONMENT_KEY, WINDOWS_USER_ENVIRONMENT_KEY];
const total = 200;
const concurrency = round === 'parallel' ? 8 : 1;
let next = 0;
let ok = 0;
let failed = 0;
const durations = [];
async function worker() {
  while (next < total) {
    const index = next++;
    const started = Date.now();
    try {
      await readWindowsRegistryKey(keys[index % 2]);
      ok += 1;
    } catch {
      failed += 1;
    }
    durations.push(Date.now() - started);
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
durations.sort((a, b) => a - b);
const pct = (p) => durations[Math.min(durations.length - 1, Math.floor(durations.length * p))];
console.log(`[e1g] round=${round} concurrency=${concurrency} reads=${total} ok=${ok} failed=${failed} ms p50=${pct(0.5)} p95=${pct(0.95)} max=${durations.at(-1)}`);
