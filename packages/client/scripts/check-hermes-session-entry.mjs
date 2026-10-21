import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Also accepts an extracted tarball root: exercise the shipped imports map.
const root = process.argv[2] ? path.resolve(process.argv[2]) : fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(path.join(root, 'package.json'));
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(manifest.exports['./hermes-session'], undefined);
const runtime = require.resolve('#byok-hermes-session');
assert.equal(runtime, realpathSync(path.join(root, 'dist/adapters/hermes/hermes-session-runtime.js')));
const { createHermesSession } = await import(pathToFileURL(runtime).href);
for (const entry of ['dist/index.js', 'dist/adapters/index.js']) {
  const text = readFileSync(path.join(root, entry), 'utf8');
  assert.match(text, /import\(["']#byok-hermes-session["']\)/);
  assert.doesNotMatch(text, /class HermesSession|HermesSession = class/);
  const api = await import(pathToFileURL(path.join(root, entry)).href);
  // Public constructor validation remains synchronous before any session loads.
  assert.throws(() => new api.HermesAdapter({ home: 'relative' }), /absolute/);
  let released = 0;
  let refuseCleanup = true;
  const homes = new Set();
  const deps = {
    RuntimeExecutionFailure: api.RuntimeExecutionFailure,
    RuntimeDisposalFailure: api.RuntimeDisposalFailure,
    infrastructure: (phase, reason, retry = 'non-retryable') => new api.RuntimeExecutionFailure({ phase, reason, retry, category: 'infrastructure' }),
    isRuntimeExecutionFailure: value => value instanceof api.RuntimeExecutionFailure,
    removeHermesProfile: async () => { if (refuseCleanup) throw new Error('synthetic cleanup refusal'); },
  };
  const session = createHermesSession({ release: async () => { released++; } }, '/synthetic', homes, 1000, deps);
  session.ownHome('/synthetic/profile');
  assert.throws(() => session.prompt('not open'), api.RuntimeExecutionFailure);
  await assert.rejects(session.close(), api.RuntimeDisposalFailure);
  assert.equal(released, 0);
  assert.equal(homes.has('/synthetic/profile'), true);
  refuseCleanup = false;
  await session.close();
  assert.equal(released, 1);
  assert.equal(homes.size, 0);
}
console.log('Hermes private entry: packaged resolution, public error identity, cleanup retry, synchronous construction passed');
