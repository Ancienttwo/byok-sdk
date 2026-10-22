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

export function verifyReviewedContent(path, { base, cwd = process.cwd() } = {}) {
  if (!/^[a-f0-9]{40}$/.test(base ?? '') || /^0+$/.test(base)) throw new Error('Content-sensitive impact requires exact CI_BASE');
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
    return;
  }
  if (path === '.node-version') {
    // #702: every CI and release setup-node step reads this pin. Admit only one
    // exact X.Y.Z line: no range, alias, prefix, prerelease or second line.
    if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\n?$/.test(afterText)) {
      throw new Error('Reviewed CI mapping required: .node-version must hold one exact X.Y.Z version');
    }
    return;
  }
  const parse = path === 'bun.lock' ? parseBunLock : JSON.parse;
  const before = parse(beforeText), after = parse(afterText);
  const version = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
  if (path === 'bun.lock') {
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
      delete record.version; delete current.version;
    }
  } else if (path === 'examples/bot-collaboration/package.json') {
    if (before.private !== true || after.private !== true
      || before.devDependencies?.['@byok-sdk/cloud'] !== undefined
      || after.devDependencies?.['@byok-sdk/cloud'] !== 'workspace:*') {
      throw new Error('Only the reviewed private fixture cloud edge may be added');
    }
    delete after.devDependencies['@byok-sdk/cloud'];
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
    // #702 raises the public Node floor with the Node 24.22.1 pin. Admit only
    // this exact engines.node edit in a public manifest. Any other engines value
    // or key, and any other field, still fails the comparison below.
    if (publicManifests.includes(path)
      && before.engines?.node === '>=24.15.0'
      && after.engines?.node === '>=24.22.1') {
      after.engines.node = before.engines.node;
    }
    delete before.version; delete after.version;
  }
  if (!isDeepStrictEqual(before, after)) throw new Error(`Reviewed CI mapping required: ${path} changes more than the reviewed fields`);
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
