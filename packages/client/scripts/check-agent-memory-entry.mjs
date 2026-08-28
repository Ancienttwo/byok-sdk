/**
 * Built-bundle half of the `@byok-sdk/client/agent-memory` contract.
 *
 * `src/__tests__/agent-memory-entry-constraints.test.ts` pins the source
 * module graph; this pins what tsup actually emitted, which is the only
 * artifact a downstream host installs. The two are not redundant: tree-shaking,
 * the entry boundary, and the `exports` map all live on this side.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const agentMemoryExport = manifest.exports?.['./agent-memory'];

assert.deepEqual(agentMemoryExport, {
  types: './dist/agent-memory/index.d.ts',
  import: './dist/agent-memory/index.js',
});

for (const relativePath of [agentMemoryExport.import, agentMemoryExport.types]) {
  assert.equal(existsSync(new URL(`..${relativePath.slice(1)}`, import.meta.url)), true, `${relativePath} is missing`);
}

const bundledEntry = readFileSync(new URL('../dist/agent-memory/index.js', import.meta.url), 'utf8');
const entryBytes = Buffer.byteLength(bundledEntry);

// No transport, no daemon composition, no control socket — the three things
// that make importing memory from the root entry unacceptable for an embedded
// host. `dist/index.js` is ~800 KB and carries all of them.
assert.doesNotMatch(bundledEntry, /(?:from|import\()\s*["']ws["']/);
assert.doesNotMatch(bundledEntry, /\bWebSocket\b/);
assert.doesNotMatch(bundledEntry, /ws-transport|long-poll-transport/);
assert.doesNotMatch(bundledEntry, /\bcreateDaemon\b/);
assert.doesNotMatch(bundledEntry, /\bconnectControlClient\b/);
assert.doesNotMatch(bundledEntry, /\bControlClient\b/);
assert.doesNotMatch(bundledEntry, /control\.sock/);
assert.doesNotMatch(bundledEntry, /snapshotAndProjectAgentMemory/);

// Upper bound, set from the measured 39,006 B build of this entry. The number
// that matters is the ratio, not the absolute size: the root entry is 817,399 B
// and the adapters entry is 121,351 B, so a leak of the daemon composition or
// the transport overshoots this ceiling by an order of magnitude and fails
// loudly. 48 KiB leaves ~26% headroom for real growth of the memory surface
// itself while staying 2.4x under the adapters entry.
const ENTRY_BYTE_CEILING = 48 * 1024;
assert.ok(
  entryBytes <= ENTRY_BYTE_CEILING,
  `dist/agent-memory/index.js is ${entryBytes} bytes, over the ${ENTRY_BYTE_CEILING} byte ceiling`,
);

const agentMemory = await import(new URL('../dist/agent-memory/index.js', import.meta.url));
assert.deepEqual(Object.keys(agentMemory).sort(), [
  'AGENT_MEMORY_GUIDANCE',
  'AGENT_MEMORY_RECALL_TOOL_NAME',
  'AGENT_MEMORY_SAVE_TOOL_NAME',
  'AgentMemoryError',
  'AgentMemoryRevisionConflictError',
  'AgentMemoryService',
  'captureAgentMemorySnapshot',
  'isAgentMemoryFilesystemHelperSupported',
  'isAgentMemorySecureFilesystemAvailable',
  'openAgentMemoryFilesystemHelper',
  'prependAgentMemoryGuidance',
  'serveAgentMemoryMcpOverStdio',
  'validateAgentMemoryPath',
]);

assert.equal(agentMemory.AGENT_MEMORY_RECALL_TOOL_NAME, 'memory.recall');
assert.equal(agentMemory.AGENT_MEMORY_SAVE_TOOL_NAME, 'memory.save');
assert.equal(agentMemory.validateAgentMemoryPath('MEMORY.md'), 'MEMORY.md');
assert.throws(() => agentMemory.validateAgentMemoryPath('../escape.md'), /memory path/);
assert.equal(typeof agentMemory.isAgentMemorySecureFilesystemAvailable(false), 'boolean');
assert.equal(agentMemory.prependAgentMemoryGuidance('do the thing').endsWith('\n\ndo the thing'), true);

// tsup emits each entry as its own bundle (`splitting: false`), so the two
// `AgentMemoryError` classes are distinct constructors. `instanceof` therefore
// does NOT hold across entries — the same reason `check-adapters-entry.mjs`
// crosses entries through `isRuntimeExecutionFailure` rather than `instanceof`.
// `.name` is the stable cross-entry discriminator, and this asserts both halves
// so the trade-off cannot silently change shape.
const root = await import(new URL('../dist/index.js', import.meta.url));
assert.notEqual(agentMemory.AgentMemoryError, root.AgentMemoryError);
const entryError = new agentMemory.AgentMemoryError('probe');
assert.equal(entryError instanceof root.AgentMemoryError, false);
assert.equal(entryError.name, 'AgentMemoryError');
assert.equal(new agentMemory.AgentMemoryRevisionConflictError('a', 'b').name, 'AgentMemoryRevisionConflictError');

console.log(JSON.stringify({
  agentMemoryEntryBytes: entryBytes,
  agentMemoryEntryCeiling: ENTRY_BYTE_CEILING,
  rootEntryBytes: Buffer.byteLength(readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8')),
  status: 'passed',
}));
