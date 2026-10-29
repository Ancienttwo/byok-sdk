// Child-only synthetic fixture. The parent kills this owned process after a durable stage.
import { HostLedger, HostMemoryPage, memoryRevision } from '@byok-sdk/server/execution-core';
const [filename, stage] = process.argv.slice(2);
const binding = { deviceId: 'device', agentRef: { agentId: 'main', profileRevision: '1' } };
const files = [{ path: 'MEMORY.md', content: '', revision: memoryRevision(''), byteCount: 0 }];
const exported = { requestedAgentRef: binding.agentRef, files, totalBytes: 0,
  snapshotDigest: memoryRevision(JSON.stringify(['byok-agent-memory-export.v1', files.map(file => [file.path, file.revision, file.byteCount])])) };
function checkpoint(): Promise<never> {
  process.stdout.write('durable-stage\n');
  return new Promise(() => { setInterval(() => {}, 1000); });
}
const ledger = new HostLedger(filename!, 'product:test');
let currentChecks = 0;
const page = new HostMemoryPage(ledger, {
  now: () => 1000, isCurrent: () => {
    currentChecks++;
    // The final commit recheck runs after async preflight. Exit before that commit.
    if (stage === 'preflight' && currentChecks === 3) { process.stdout.write('durable-stage\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }
    return true;
  }, notify: async () => {}, authorizeProjection: () => true,
  exportMemory: async () => { if (stage === 'gate') await checkpoint(); return exported; },
});
const target = ['MEMORY.md', 'notes/a.md', 'notes/b.md'].map(path => ({ path, content: 'synthetic', revision: memoryRevision('synthetic'), byteCount: 9 }));
const restore = await page.restore({ ...binding, restoreId: 'crash-restore', files: target, mode: 'initial', expiresAt: 5000 });
if (stage === 'readback') {
  const intent = page.intent(restore.files[0]!.intentId!)!.intent;
  const port = page.transport(binding.deviceId);
  await port.fetch({ intentId: intent.intentId, agentRef: binding.agentRef, reservation: 'held' });
  await port.complete({ intentId: intent.intentId, agentRef: binding.agentRef, path: intent.path, operation: intent.operation,
    operationDigest: intent.operationDigest, outcome: 'applied', result: { exists: true, revision: intent.targetRevision! } });
}
await checkpoint();
