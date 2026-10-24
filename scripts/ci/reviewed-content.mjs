import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseBunLock } from '../release/pi-runtime-identity.mjs';

// The nine published manifests. A contract test keeps this list equal to the
// non-private packages/*/package.json files.
export const publicManifests = Object.freeze([
  'client', 'cloud', 'cloud-dataplane', 'cloud-do', 'core', 'keys', 'protocol', 'server', 'ui-runtime',
].map(name => `packages/${name}/package.json`));

// #700 moves the exact undici pin from 8.11.2 to the patched 8.12.3. 8.12.2 is
// the first 8.x release that fixes the 2026-10-15 advisories. Each workspace
// below declares undici in exactly this manifest field.
const UNDICI_MOVE = { from: '8.11.2', to: '8.12.3' };
const UNDICI_FIELDS = { 'packages/client': 'dependencies', 'packages/cloud-dataplane': 'devDependencies' };
const UNDICI_LOCK = {
  from: ['undici@8.11.2', '', {}, 'sha512-u4UB2/IrKdU6lFxumHmmo1a3fCQO5tzQllRorfoRS63txhrB7xTpSn1PftwC4qEHkOaqP95fCWW4lJzwErwzhQ=='],
  to: ['undici@8.12.3', '', {}, 'sha512-+fdndUTwBP86cVjihTp21hZHo7d6oj1c/47XPA3lL8mM0XHs+C4EkcjmgRsFnFk2f/UONGDy9ItBItmXsLOQHw=='],
};
// Restore the reviewed old pin, so that the deep comparison still sees every other change.
function revertUndiciMove(before, after, field) {
  if (before?.[field]?.undici !== UNDICI_MOVE.from || after?.[field]?.undici !== UNDICI_MOVE.to) return false;
  after[field].undici = UNDICI_MOVE.from;
  return true;
}

const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// #793 D2 (owner O8): the private hosted (H) example. Its manifest has a fixed
// shape. It may only reuse workspaces and dependency specs that another
// workspace manifest already declares, so it adds no package and moves no version.
const HOSTED = Object.freeze({ dir: 'examples/hosted-bot-collaboration', name: '@byok-sdk/example-hosted-bot-collaboration' });
const HOSTED_FIELDS = new Set(['name', 'version', 'private', 'type', 'description', 'scripts', 'dependencies', 'devDependencies']);
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies'];
// #793 D2a-0: the K8 entries that the hosted example imports. There is no root
// entry, so H never loads the K8 host (src/host.ts). The K8 rules still import
// the K4 root, which loads HostLedger and node:sqlite.
const K8_HOSTED_EXPORTS = Object.freeze({
  './rules/commands': './src/rules/commands.ts',
  './rules/commit': './src/rules/commit.ts',
  './model': './src/model.ts',
  './coalesce': './src/coalesce.ts',
  './team': './src/team.ts',
  './test-support': './src/commit-vectors.test-support.ts',
});
// #793 D2g: the K8 retention rule and its shared vectors, added to the hosted
// entries for H's retention slice (owner question §53d).
const K8_RETENTION_EXPORTS = Object.freeze({
  './retention': './src/retention.ts',
  './retention-vectors': './src/retention-vectors.test-support.ts',
});
// #793 D2f-1: the K8 Bot routine policy and its shared vectors, added to the
// hosted and retention entries. src/routines.ts does not load the K8 host.
const K8_ROUTINE_EXPORTS = Object.freeze({
  './routines': './src/routines.ts',
  './routine-vectors': './src/routine-vectors.test-support.ts',
});
function otherWorkspaceManifests(cwd) {
  const manifests = [];
  for (const prefix of ['packages', 'examples']) {
    if (!existsSync(resolve(cwd, prefix))) continue;
    for (const name of readdirSync(resolve(cwd, prefix))) {
      const file = resolve(cwd, prefix, name, 'package.json');
      if (`${prefix}/${name}` !== HOSTED.dir && existsSync(file)) manifests.push(JSON.parse(readFileSync(file, 'utf8')));
    }
  }
  return manifests;
}
function verifyHostedManifest(manifest, cwd) {
  if (!plain(manifest) || Object.keys(manifest).some(key => !HOSTED_FIELDS.has(key))
    || manifest.name !== HOSTED.name || manifest.private !== true || manifest.type !== 'module' || !version(manifest.version)
    || (manifest.description !== undefined && typeof manifest.description !== 'string')
    || !isDeepStrictEqual(manifest.scripts, { typecheck: 'tsc --noEmit', test: 'vitest run' })) {
    throw new Error('Reviewed CI mapping required: the hosted example manifest has an unreviewed shape');
  }
  const others = otherWorkspaceManifests(cwd);
  for (const field of DEPENDENCY_FIELDS) {
    if (manifest[field] === undefined) continue;
    if (!plain(manifest[field])) throw new Error('Reviewed CI mapping required: the hosted example manifest has an unreviewed shape');
    for (const [name, spec] of Object.entries(manifest[field])) {
      const reused = name.startsWith('@byok-sdk/')
        ? spec === 'workspace:*' && others.some(other => other.name === name)
        : others.some(other => DEPENDENCY_FIELDS.some(declared => other[declared]?.[name] === spec));
      if (!reused) throw new Error(`Reviewed CI mapping required: the hosted example may only reuse a declared dependency spec (${name})`);
    }
  }
  return manifest;
}
/** Admits the hosted example's own lock rows when they match its reviewed manifest. Every other lock byte stays compared. */
function admitHostedLock(before, after, cwd) {
  const entry = after.workspaces?.[HOSTED.dir];
  if (entry === undefined) return;
  const manifest = verifyHostedManifest(JSON.parse(readFileSync(resolve(cwd, HOSTED.dir, 'package.json'), 'utf8')), cwd);
  const expected = { name: manifest.name, version: manifest.version };
  for (const field of DEPENDENCY_FIELDS) if (manifest[field] !== undefined) expected[field] = manifest[field];
  const row = [`${HOSTED.name}@workspace:${HOSTED.dir}`];
  if (!isDeepStrictEqual(entry, expected) || !isDeepStrictEqual(after.packages?.[HOSTED.name], row)
    || (before.packages?.[HOSTED.name] !== undefined && !isDeepStrictEqual(before.packages[HOSTED.name], row))) {
    throw new Error('Reviewed CI mapping required: the hosted example lock rows differ from its manifest');
  }
  delete before.workspaces[HOSTED.dir]; delete after.workspaces[HOSTED.dir];
  if (before.packages) delete before.packages[HOSTED.name];
  delete after.packages[HOSTED.name];
}

/** Returns the workspaces whose suites must qualify a reviewed dependency move. */
export function verifyReviewedContent(path, { base, cwd = process.cwd() } = {}) {
  if (!/^[a-f0-9]{40}$/.test(base ?? '') || /^0+$/.test(base)) throw new Error('Content-sensitive impact requires exact CI_BASE');
  if (path === `${HOSTED.dir}/package.json`) {
    // A new file has no base content, so the reviewed shape is the whole check.
    verifyHostedManifest(JSON.parse(readFileSync(resolve(cwd, path), 'utf8')), cwd);
    return [];
  }
  const beforeText = execFileSync('git', ['show', `${base}:${path}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const afterText = readFileSync(resolve(cwd, path), 'utf8');
  if (path === '.gitattributes') {
    // #603 pins both generated metadata and native build input bytes.
    // Admit only the reviewed additive LF rules, never unrelated attributes.
    const rule = 'packages/client/src/daemon/agent-memory-helper-release-pin.ts text eol=lf\n';
    const before = beforeText.replace(/\r\n/g, '\n');
    const after = afterText.replace(/\r\n/g, '\n');
    const nativeRules = 'packages/client/native/agent-memory-fs/*.go text eol=lf\n'
      + 'packages/client/native/agent-memory-fs/go.mod text eol=lf\n';
    const additions = [rule, nativeRules, rule + nativeRules];
    if (!additions.some(addition => after === before + addition
      && addition.trimEnd().split('\n').every(line => !before.split('\n').includes(line)))) {
      throw new Error('Reviewed CI mapping required: only the reviewed helper LF attributes may be added');
    }
    return [];
  }
  if (path === '.node-version') {
    // #702: every CI and release setup-node step reads this pin. Admit only one
    // exact X.Y.Z line: no range, alias, prefix, prerelease or second line.
    if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\n?$/.test(afterText)) {
      throw new Error('Reviewed CI mapping required: .node-version must hold one exact X.Y.Z version');
    }
    return [];
  }
  const parse = path === 'bun.lock' ? parseBunLock : JSON.parse;
  const qualify = [];
  const before = parse(beforeText), after = parse(afterText);
  if (path === 'bun.lock') {
    admitHostedLock(before, after, cwd);
    for (const [dir, record] of Object.entries(before.workspaces)) {
      if (dir === '') continue;
      const current = after.workspaces?.[dir];
      if (!current || !version(record.version) || !version(current.version)) throw new Error('Invalid workspace lock version');
      const manifest = JSON.parse(readFileSync(resolve(cwd, dir, 'package.json'), 'utf8'));
      if (current.version !== manifest.version) throw new Error('Lock version differs from workspace manifest');
      // #658 adds this existing workspace solely to the private mailbox fixture.
      // Normalize only that reviewed additive edge; all other lock bytes remain
      // subject to the deep comparison below (including resolved packages).
      if (dir === 'examples/bot-collaboration'
        && record.devDependencies?.['@byok-sdk/cloud'] === undefined
        && current.devDependencies?.['@byok-sdk/cloud'] === 'workspace:*'
        && manifest.private === true
        && manifest.devDependencies?.['@byok-sdk/cloud'] === 'workspace:*') {
        delete current.devDependencies['@byok-sdk/cloud'];
      }
      // #603 exposes the already resolved bundler to helper asset smoke tests.
      if (dir === 'packages/client'
        && record.devDependencies?.esbuild === undefined
        && current.devDependencies?.esbuild === '0.28.1'
        && manifest.devDependencies?.esbuild === '0.28.1') {
        delete current.devDependencies.esbuild;
      }
      const undiciField = UNDICI_FIELDS[dir];
      if (undiciField && manifest[undiciField]?.undici === UNDICI_MOVE.to && revertUndiciMove(record, current, undiciField)) qualify.push(dir);
      delete record.version; delete current.version;
    }
    // Both workspace pins and the resolved package move together, or nothing moves.
    if (qualify.length) {
      if (qualify.length !== Object.keys(UNDICI_FIELDS).length
        || !isDeepStrictEqual(before.packages?.undici, UNDICI_LOCK.from) || !isDeepStrictEqual(after.packages?.undici, UNDICI_LOCK.to)) {
        throw new Error('Reviewed CI mapping required: bun.lock must move both undici pins and the resolved undici entry together');
      }
      after.packages.undici = before.packages.undici;
    }
  } else if (path === 'examples/bot-collaboration/package.json') {
    if (before.private !== true || after.private !== true) throw new Error('The bot collaboration fixture must stay private');
    // #658: the private fixture cloud edge.
    if (before.devDependencies?.['@byok-sdk/cloud'] === undefined && after.devDependencies?.['@byok-sdk/cloud'] === 'workspace:*') {
      delete after.devDependencies['@byok-sdk/cloud'];
    }
    // #793 D2a-0: the K8 entries for the hosted example.
    if (before.exports === undefined && isDeepStrictEqual(after.exports, K8_HOSTED_EXPORTS)) delete after.exports;
    // #793 D2g: the retention entries, only on top of exactly the hosted entries.
    if (isDeepStrictEqual(before.exports, K8_HOSTED_EXPORTS) && isDeepStrictEqual(after.exports, { ...K8_HOSTED_EXPORTS, ...K8_RETENTION_EXPORTS })) {
      after.exports = before.exports;
    }
    // #793 D2f-1: the routine entries, only on top of exactly the hosted and retention entries.
    const retained = { ...K8_HOSTED_EXPORTS, ...K8_RETENTION_EXPORTS };
    if (isDeepStrictEqual(before.exports, retained) && isDeepStrictEqual(after.exports, { ...retained, ...K8_ROUTINE_EXPORTS })) {
      after.exports = before.exports;
    }
  } else if (path === 'package.json') {
    const oldCommand = before.scripts?.['test:scripts'], newCommand = after.scripts?.['test:scripts'];
    const prefix = 'node --test --test-concurrency=1 ';
    if (!oldCommand?.startsWith(prefix) || !newCommand?.startsWith(prefix)) throw new Error('Unreviewed test command');
    const oldTests = oldCommand.slice(prefix.length).split(' '), newTests = newCommand.slice(prefix.length).split(' ');
    let index = 0;
    for (const test of newTests) {
      if (test === oldTests[index]) { index++; continue; }
      if (!/^scripts\/ci\/[a-z0-9-]+\.test\.mjs$/.test(test) || oldTests.includes(test) || !existsSync(resolve(cwd, test))) throw new Error('Only existing CI contract tests may be added');
    }
    if (index !== oldTests.length || new Set(newTests).size !== newTests.length) throw new Error('Existing tests must remain in order without duplicates');
    delete before.scripts['test:scripts']; delete after.scripts['test:scripts'];
  } else {
    if (!version(before.version) || !version(after.version)) throw new Error('Invalid package version');
    if (path === 'packages/client/package.json'
      && before.devDependencies?.esbuild === undefined
      && after.devDependencies?.esbuild === '0.28.1') {
      delete after.devDependencies.esbuild;
    }
    if (path === 'packages/client/package.json') {
      const key = '#byok-hermes-session';
      const entry = { types: './dist/adapters/hermes/hermes-session-runtime.d.ts', default: './dist/adapters/hermes/hermes-session-runtime.js' };
      if (before.imports?.[key] === undefined && isDeepStrictEqual(after.imports?.[key], entry)) delete after.imports[key];
      const smoke = ' && node scripts/check-hermes-session-entry.mjs';
      if (typeof before.scripts?.build === 'string' && after.scripts?.build === before.scripts.build + smoke) after.scripts.build = before.scripts.build;
      // #635 adds the public transport-free test-double entry; its bundle is checked by check-adapters-entry.mjs.
      const testing = { types: './dist/testing/index.d.ts', import: './dist/testing/index.js' };
      if (before.exports?.['./testing'] === undefined && isDeepStrictEqual(after.exports?.['./testing'], testing)) delete after.exports['./testing'];
    }
    if (path === 'packages/keys/package.json') {
      // #636 adds one subpath for the generated pinned pi-ai catalog lookup.
      const key = './pi-catalog';
      const entry = { types: './dist/pi-catalog.d.ts', import: './dist/pi-catalog.js' };
      if (before.exports?.[key] === undefined && isDeepStrictEqual(after.exports?.[key], entry)) delete after.exports[key];
    }
    if (path === 'packages/core/package.json') {
      // #654 adds one subpath for sealed payload v1, so the root bundle does not grow.
      const key = './sealed-payload';
      const entry = { types: './dist/sealed-payload/index.d.ts', import: './dist/sealed-payload/index.js' };
      if (before.exports?.[key] === undefined && isDeepStrictEqual(after.exports?.[key], entry)) delete after.exports[key];
    }
    // #702 raises the public Node floor with the Node 24.22.1 pin. Admit only
    // this exact engines.node edit in a public manifest. Any other engines value
    // or key, and any other field, still fails the comparison below.
    if (publicManifests.includes(path)
      && before.engines?.node === '>=24.15.0'
      && after.engines?.node === '>=24.22.1') {
      after.engines.node = before.engines.node;
    }
    const dir = path.slice(0, -'/package.json'.length);
    if (UNDICI_FIELDS[dir] && revertUndiciMove(before, after, UNDICI_FIELDS[dir])) qualify.push(dir);
    delete before.version; delete after.version;
  }
  if (!isDeepStrictEqual(before, after)) throw new Error(`Reviewed CI mapping required: ${path} changes more than the reviewed fields`);
  return qualify;
}

/** A `bin:<name>` entry belongs to the one workspace package whose manifest declares that bin. */
function binOwner(name, cwd) {
  const owners = readdirSync(resolve(cwd, 'packages')).filter(dir => {
    const manifest = resolve(cwd, 'packages', dir, 'package.json');
    return existsSync(manifest) && Object.hasOwn(JSON.parse(readFileSync(manifest, 'utf8')).bin ?? {}, name);
  });
  if (owners.length !== 1) throw new Error(`Reviewed CI mapping required: unmapped API entry bin:${name}`);
  return `packages/${owners[0]}`;
}

export function changedApiOwners({ base, cwd = process.cwd() } = {}) {
  if (!/^[a-f0-9]{40}$/.test(base ?? '') || /^0+$/.test(base)) throw new Error('API impact requires exact CI_BASE');
  const before = JSON.parse(execFileSync('git', ['show', `${base}:api-surface/entries.json`], { cwd, encoding: 'utf8' }));
  const after = JSON.parse(readFileSync(resolve(cwd, 'api-surface/entries.json'), 'utf8'));
  const owners = new Set();
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (isDeepStrictEqual(before[key], after[key])) continue;
    const bin = /^bin:([a-z0-9-]+)$/.exec(key);
    if (bin) { owners.add(binOwner(bin[1], cwd)); continue; }
    const match = /^@byok-sdk\/([a-z-]+)(?:[/#]|$)/.exec(key);
    if (!match) throw new Error(`Reviewed CI mapping required: unmapped API entry ${key}`);
    owners.add(`packages/${match[1]}`);
  }
  return [...owners];
}
