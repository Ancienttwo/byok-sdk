// Bounded synthetic measurement. Creates and removes only its own temporary databases.
// Run from packages/server: node --import tsx src/__tests__/execution-core/fixtures/retention-benchmark.ts [baseline-ledger-module-url]
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { HostLedger, MIN_TOMBSTONE_RETENTION_MS } from '../../../execution-core/ledger';
import { hash, type IntentInput } from '../../../execution-core/model';
import { enqueue, settle } from '../../../execution-core/transitions';

const Ledger = process.argv[2] ? (await import(process.argv[2])).HostLedger as typeof HostLedger : HostLedger;
const root = mkdtempSync(join(tmpdir(), 'k4-retention-benchmark-'));
try {
  for (const [count, instructionBytes, documentBytes] of [[10, 48 * 1024, 64 * 1024], [1000, 128, 256], [10000, 128, 256]] as const) {
    const ledger = new Ledger(join(root, `${count}.sqlite`), 'synthetic');
    try {
      const keys = Array.from({ length: count }, (_, index) => `turn-${index}`);
      ledger.transaction(state => {
        for (const key of keys) {
          const input: IntentInput = { key, source: 'user', waitUntil: 1000, execution: { deviceId: 'synthetic', payload: {
            session: { mode: 'fresh' }, instruction: 'i'.repeat(instructionBytes), runtime: 'pi', agentRef: { agentId: 'main', profileRevision: '1' },
            egressPolicy: { policyRevision: 'synthetic', activity: { delivery: 'latest-value', maxCoalesceMs: 250, maxEventBytes: 262144 },
              reliable: { maxPendingEventsPerAgent: 16, maxPendingBytesPerAgent: 4096, maxPendingBytesPerTenant: 16384 },
              transfers: { workspace: 'disabled', transcript: 'disabled', artifact: 'disabled' } },
            terminalProjection: { mode: 'result-document', contract: 'synthetic', schema: { type: 'string' } },
          } } };
          const intent = enqueue(state, ledger.tenant, input);
          state.executions[intent.taskId]!.terminal = { recordedAt: '2026-01-01T00:00:00Z', envelope: {
            v: 1, id: '00000000-0000-4000-8000-000000000001', ts: '2026-01-01T00:00:00Z', type: 'task.complete',
            task_id: intent.taskId, seq: 1, payload: { summary: '', sessionRef: 'synthetic', document: 'o'.repeat(documentBytes - 2) },
          } };
          state.applied[intent.taskId] = true;
          settle(state, intent, 'succeeded');
          delete state.outbox[`projection:${hash(`intent:${key}`)}`];
        }
      });
      const measure = () => {
        const bodyBytes = Buffer.byteLength(JSON.stringify(ledger.snapshot()));
        const rewriteMs = Array.from({ length: 3 }, () => {
          const start = performance.now(); ledger.transaction(state => { state.scanSequence++; });
          return Number((performance.now() - start).toFixed(3));
        });
        return { bodyBytes, rewriteMs };
      };
      const before = measure();
      const start = performance.now();
      const compacted = typeof ledger.compact === 'function'
        ? ledger.compact({ acknowledgedIntentKeys: keys, now: 1000, tombstoneRetentionMs: MIN_TOMBSTONE_RETENTION_MS }) : undefined;
      const compactionMs = compacted ? Number((performance.now() - start).toFixed(3)) : undefined;
      console.log(JSON.stringify({ count, instructionBytes, documentBytes, before, compactionMs,
        compacted, after: compacted ? measure() : undefined }));
    } finally { ledger.close(); }
  }
} finally { rmSync(root, { recursive: true, force: true }); }
