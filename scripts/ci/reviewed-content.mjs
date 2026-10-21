import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseBunLock } from '../release/pi-runtime-identity.mjs';

// Reviewed projection of public package bin ownership; CI tests compare manifests.
export const reviewedBinOwners = Object.freeze({
  'bin:byok-agent': 'packages/client',
  'bin:byok-agent-message-mcp': 'packages/client',
  'bin:byok-agent-result-mcp': 'packages/client',
  'bin:byok-agent-memory-mcp': 'packages/client',
  'bin:byok-agent-team-mcp': 'packages/client',
  'bin:byok-pi-durable': 'packages/client',
  'bin:byok-pi-prepared': 'packages/client',
  'bin:byok-pi-rpc': 'packages/client',
  'bin:byok-pi-provider-launcher': 'packages/keys',
});

// #626's private packaging fixture imports these two existing workspaces.
function removeReviewedPackagingEdges(before, after, manifest) {
  if (manifest.private !== true) throw new Error('Reviewed packaging fixture must remain private');
  for (const name of ['@byok-sdk/keys', '@byok-sdk/server']) {
    if (before.dependencies?.[name] !== undefined || after.dependencies?.[name] !== 'workspace:*'
      || manifest.dependencies?.[name] !== 'workspace:*') {
      throw new Error('Only the reviewed additive packaging workspace dependencies may be added');
    }
    delete after.dependencies[name];
  }
}

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
      throw new Error('Reviewed release validation required: only the reviewed helper LF attributes may be added');
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
      if (dir === 'examples/packaging'
        && record.dependencies?.['@byok-sdk/keys'] === undefined
        && record.dependencies?.['@byok-sdk/server'] === undefined
        && (current.dependencies?.['@byok-sdk/keys'] !== undefined || current.dependencies?.['@byok-sdk/server'] !== undefined)) {
        removeReviewedPackagingEdges(record, current, manifest);
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
  } else if (path === 'examples/packaging/package.json') {
    if (before.private !== true) throw new Error('Reviewed packaging fixture must remain private');
    removeReviewedPackagingEdges(before, after, { ...after, dependencies: { ...after.dependencies } });
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
    }
    delete before.version; delete after.version;
  }
  if (!isDeepStrictEqual(before, after)) throw new Error(`Reviewed release validation required: ${path} changes more than the reviewed fields`);
}

export function changedApiOwners({ base, cwd = process.cwd() } = {}) {
  if (!/^[a-f0-9]{40}$/.test(base ?? '') || /^0+$/.test(base)) throw new Error('API impact requires exact CI_BASE');
  const before = JSON.parse(execFileSync('git', ['show', `${base}:api-surface/entries.json`], { cwd, encoding: 'utf8' }));
  const after = JSON.parse(readFileSync(resolve(cwd, 'api-surface/entries.json'), 'utf8'));
  const owners = new Set();
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (isDeepStrictEqual(before[key], after[key])) continue;
    if (Object.hasOwn(reviewedBinOwners, key)) { owners.add(reviewedBinOwners[key]); continue; }
    const match = /^@byok-sdk\/([a-z-]+)(?:[/#]|$)/.exec(key);
    if (!match) throw new Error(`Reviewed release validation required: unmapped API entry ${key}`);
    owners.add(`packages/${match[1]}`);
  }
  return [...owners];
}
