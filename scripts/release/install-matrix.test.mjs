import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { workerConsumerImports } from './cloud-do-consumer-smoke.mjs';
import { readPublicManifests } from './publish.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const runtimeFields = ['dependencies', 'optionalDependencies', 'peerDependencies'];

// The direct packages of each README install set. Self-hosted and Hosted are the
// sets ruled in #535 over the unchanged ADR-035 topology. The Worker set is not
// ruled: it is exactly what the installed Worker consumer of check:release-pack
// imports (scripts/release/cloud-do-consumer-smoke.mjs).
const expectedSets = new Map([
  ['Self-hosted', ['@byok-sdk/client', '@byok-sdk/keys', '@byok-sdk/server']],
  ['Hosted / Cloudflare', ['@byok-sdk/cloud', '@byok-sdk/cloud-dataplane', '@byok-sdk/cloud-do', '@byok-sdk/ui-runtime']],
  ['Worker', workerConsumerImports],
]);

function parseInstallMatrix(readme) {
  const begin = readme.indexOf('<!-- BEGIN install-matrix -->');
  const end = readme.indexOf('<!-- END install-matrix -->');
  if (begin === -1 || end < begin) throw new Error('README.md has no install-matrix block');
  const sets = new Map();
  for (const section of readme.slice(begin, end).split(/^### /m).slice(1)) {
    const [title, ...lines] = section.split('\n');
    const body = lines.join('\n');
    const words = (pattern) => [...body.matchAll(pattern)].flatMap((match) => match[1].trim().split(/\s+/));
    const also = /^Also installed: (.+)\.$/m.exec(body);
    sets.set(title.trim(), {
      installs: words(/^npm install (?!--save-dev )(.+)$/gm),
      devInstalls: words(/^npm install --save-dev (.+)$/gm),
      also: also === null ? undefined : also[1] === 'none' ? [] : [...also[1].matchAll(/`([^`]+)`/g)].map((match) => match[1]),
    });
  }
  return sets;
}

/** The @byok-sdk packages npm installs for `direct`, following runtime dependency fields. */
function runtimeClosure(direct, manifests) {
  const closure = new Set();
  const pending = [...direct];
  while (pending.length > 0) {
    const name = pending.pop();
    if (closure.has(name)) continue;
    closure.add(name);
    const manifest = manifests.get(name)?.manifest ?? {};
    for (const field of runtimeFields) {
      for (const dependency of Object.keys(manifest[field] ?? {})) {
        if (manifests.has(dependency)) pending.push(dependency);
      }
    }
  }
  return closure;
}

function installMatrixErrors(readme, manifests) {
  const errors = [];
  const sets = parseInstallMatrix(readme);
  if (JSON.stringify([...sets.keys()]) !== JSON.stringify([...expectedSets.keys()])) {
    errors.push(`install sets are ${JSON.stringify([...sets.keys()])}, expected ${JSON.stringify([...expectedSets.keys()])}`);
  }
  for (const [title, set] of sets) {
    const direct = [];
    for (const spec of set.installs) {
      const at = spec.lastIndexOf('@');
      const name = spec.slice(0, at);
      const version = spec.slice(at + 1);
      const manifest = manifests.get(name);
      if (at <= 0 || !manifest) {
        errors.push(`${title}: ${spec} is not a public workspace package pinned to an exact version`);
        continue;
      }
      if (version !== manifest.version) errors.push(`${title}: ${spec} does not match ${manifest.directory}/package.json (${manifest.version})`);
      direct.push(name);
    }
    const expected = expectedSets.get(title);
    if (expected && JSON.stringify([...direct].sort()) !== JSON.stringify([...expected].sort())) {
      errors.push(`${title}: installs ${JSON.stringify(direct)}, expected ${JSON.stringify(expected)}`);
    }
    const transitive = [...runtimeClosure(direct, manifests)].filter((name) => !direct.includes(name)).sort();
    if (set.also === undefined) {
      errors.push(`${title}: no "Also installed:" line`);
    } else if (JSON.stringify([...set.also].sort()) !== JSON.stringify(transitive)) {
      errors.push(`${title}: "Also installed" is ${JSON.stringify(set.also)}, the runtime dependencies install ${JSON.stringify(transitive)}`);
    }
  }
  return errors;
}

const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
const manifests = readPublicManifests(path.join(repoRoot, 'packages'));

test('README install sets match the package manifests and their runtime dependency closure', () => {
  assert.deepEqual(installMatrixErrors(readme, manifests), []);
});

test('the README Worker set is the installed Worker consumer of check:release-pack', () => {
  const worker = parseInstallMatrix(readme).get('Worker');
  assert.deepEqual(worker.installs.map((spec) => spec.slice(0, spec.lastIndexOf('@'))).sort(), workerConsumerImports);
  // The smoke type-checks that consumer against the Workers types cloud-do pins.
  const cloudDo = manifests.get('@byok-sdk/cloud-do').manifest;
  assert.ok(cloudDo.devDependencies?.['@cloudflare/workers-types'], 'cloud-do pins @cloudflare/workers-types for the Worker smoke');
  assert.deepEqual(worker.devInstalls, ['@cloudflare/workers-types']);
});

test('the install-matrix check reports drift instead of passing it', () => {
  const train = manifests.get('@byok-sdk/core').version;
  const drift = [
    [`npm install @byok-sdk/client@${train}`, 'npm install @byok-sdk/client@0.0.1'],
    ['Also installed: `@byok-sdk/core`, `@byok-sdk/protocol`.', 'Also installed: `@byok-sdk/core`.'],
    [` @byok-sdk/protocol@${train}\nnpm install --save-dev`, ` @byok-sdk/byok-sdk@${train}\nnpm install --save-dev`],
  ];
  let drifted = readme;
  for (const [from, to] of drift) {
    assert.ok(drifted.includes(from), `the README carries ${JSON.stringify(from)}`);
    drifted = drifted.replace(from, to);
  }
  const errors = installMatrixErrors(drifted, manifests);
  assert.ok(errors.some((error) => /^Self-hosted: @byok-sdk\/client@0\.0\.1 does not match packages\/client\/package\.json/.test(error)), errors.join('\n'));
  assert.ok(errors.some((error) => /^Hosted \/ Cloudflare: "Also installed" is \["@byok-sdk\/core"\]/.test(error)), errors.join('\n'));
  assert.ok(errors.some((error) => error.startsWith(`Worker: @byok-sdk/byok-sdk@${train} is not a public workspace package`)), errors.join('\n'));
});
