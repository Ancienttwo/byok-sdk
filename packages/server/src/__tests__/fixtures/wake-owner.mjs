import { createByokServer } from '../../../dist/index.js';
import { DatabaseSync } from 'node:sqlite';
const [file, mode] = process.argv.slice(2);
let server;
try {
  server = createByokServer({ productId: 'wake-file', storage: { kind: 'sqlite', path: file },
    wake: { consume: async (wake, signal) => {
      // A separate Host-owned occurrence ledger, never a live server reader.
      const ledger = new DatabaseSync(`${file}.host`);
      try {
        ledger.exec('CREATE TABLE IF NOT EXISTS occurrence (dedup_key TEXT PRIMARY KEY, execution_id TEXT NOT NULL)');
        ledger.prepare('INSERT OR IGNORE INTO occurrence VALUES (?, ?)').run(wake.dedupKey, 'execution-one');
      } finally { ledger.close(); }
      process.stdout.write(`${JSON.stringify({ kind: 'delivery', wake, aborted: signal.aborted })}\n`);
      await new Promise(() => {});
    } } });
} catch (error) {
  process.stdout.write(`${JSON.stringify({ kind: 'refused', name: error.name, code: error.code })}\n`);
  process.exitCode = 0;
}
if (server) {
  const alive = setInterval(() => {}, 1000);
  process.stdin.once('data', async () => {
    await server.close(); clearInterval(alive); process.stdin.pause();
  });
  if (mode === 'schedule') await server.wakes.schedule({ dedupKey: 'occurrence', availableAt: Date.now() - 1, payload: 'host-reference' });
}
