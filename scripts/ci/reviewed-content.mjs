import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseBunLock } from '../release/pi-runtime-identity.mjs';

export function verifyReviewedContent(path, { base, cwd = process.cwd() } = {}) {
  if (!/^[a-f0-9]{40}$/.test(base ?? '') || /^0+$/.test(base)) throw new Error('Content-sensitive impact requires exact CI_BASE');
  const beforeText = execFileSync('git', ['show', `${base}:${path}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const afterText = readFileSync(resolve(cwd, path), 'utf8');
  if (path === '.gitattributes') {
    // #603's generated pin is compared byte-for-byte with an LF projection.
    // Git attribute syntax is line based; permit only this exact additive rule.
    const rule = 'packages/client/src/daemon/agent-memory-helper-release-pin.ts text eol=lf\n';
    const before = beforeText.replace(/\r\n/g, '\n');
    const after = afterText.replace(/\r\n/g, '\n');
    if (before.includes(rule) || after !== before + rule) {
      throw new Error('Reviewed release validation required: only the reviewed helper pin LF attribute may be added');
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
    const match = /^@byok-sdk\/([a-z-]+)(?:[/#]|$)/.exec(key);
    if (!match) throw new Error(`Reviewed release validation required: unmapped API entry ${key}`);
    owners.add(`packages/${match[1]}`);
  }
  return [...owners];
}
