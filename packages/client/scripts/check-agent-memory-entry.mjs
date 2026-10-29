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

const agentMemory = await import(new URL('../dist/agent-memory/index.js', import.meta.url));
assert.deepEqual(Object.keys(agentMemory).sort(), [
  'AGENT_MEMORY_GUIDANCE',
  'AGENT_MEMORY_RECALL_TOOL_NAME',
  'AGENT_MEMORY_SAVE_TOOL_NAME',
  'AgentMemoryRevisionConflictError',
  'AgentMemoryService',
  'captureAgentMemorySnapshot',
  'isAgentMemoryFilesystemHelperSupported',
  'isAgentMemorySecureFilesystemAvailable',
  'openAgentMemoryFilesystemHelper',
  'prependAgentMemoryGuidance',
  'serveAgentMemoryMcpOverStdio',
]);

assert.equal(agentMemory.AGENT_MEMORY_RECALL_TOOL_NAME, 'memory_recall');
assert.equal(agentMemory.AGENT_MEMORY_SAVE_TOOL_NAME, 'memory_save');
assert.equal(typeof agentMemory.isAgentMemorySecureFilesystemAvailable(false), 'boolean');
assert.equal(agentMemory.prependAgentMemoryGuidance('do the thing').endsWith('\n\ndo the thing'), true);

// tsup emits each entry as its own bundle (`splitting: false`), so a class
// defined in this package is a distinct constructor per entry and `instanceof`
// does NOT hold across entries. The base `AgentMemoryError` is defined once in
// `@byok-sdk/protocol/agent-memory`, which both entries import externally, so `instanceof`
// against it holds from either entry. `.name` stays the cross-entry
// discriminator for the subclasses; this asserts both halves.
const root = await import(new URL('../dist/index.js', import.meta.url));
const { AgentMemoryError } = await import('@byok-sdk/protocol/agent-memory');
assert.notEqual(agentMemory.AgentMemoryRevisionConflictError, root.AgentMemoryRevisionConflictError);
const entryError = new agentMemory.AgentMemoryRevisionConflictError('a', 'b');
assert.equal(entryError instanceof root.AgentMemoryRevisionConflictError, false);
assert.equal(entryError instanceof AgentMemoryError, true);
assert.equal(new agentMemory.AgentMemoryRevisionConflictError('a', 'b').name, 'AgentMemoryRevisionConflictError');

console.log(JSON.stringify({
  agentMemoryEntryBytes: entryBytes,
  rootEntryBytes: Buffer.byteLength(readFileSync(new URL('../dist/index.js', import.meta.url), 'utf8')),
  status: 'passed',
}));
